/**
 * poolServe — preflight for the `pool-serve` agentAction.
 *
 * The warm-pool OWNER. Runs always-on and serves the pool API the dashboard
 * calls to claim a pre-booted, frozen runner. It owns runner capacity only;
 * every runner is responsible for its own local LiteLLM lifecycle.
 *
 * Single process = single owner = the claim is a synchronous in-memory pick,
 * which is why this sidesteps the distributed-lock problem (see PoolManager).
 *
 * Endpoints (POOL_API_PORT, default 4100 — exposed publicly + authed):
 *   GET  /healthz       — 200 { ok, repos } (no auth)
 *   GET  /pool/status   — auth: Bearer/X-Api-Key $POOL_API_KEY → counts
 *   POST /pool/claim    — auth: $POOL_API_KEY; body = the runner job.
 *                         200 { ok:true, machineId } on success,
 *                         503 { ok:false, reason } when empty/failed
 *                         (the dashboard then falls back to create-fresh).
 *
 * Secrets: POOL_API_KEY (dashboard↔owner) and RUNNER_API_KEY (owner↔machine)
 * are both derived from KODY_MASTER_KEY via HKDF — never transmitted.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { gitHubActionsDegraded } from "../github-health.js"
import { runAgentResponsibilityFallbackTick } from "../pool/agent-responsibility-fallback-tick.js"
import type { FlyGuest } from "../pool/fly.js"
import { bearerOk, derivePoolApiKey, deriveRunnerApiKey, masterKeyBytes } from "../pool/keys.js"
import { type ClaimRequest, PoolRegistry } from "../pool/registry.js"

const PERF_GUEST: Record<string, FlyGuest> = {
  low: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
  medium: { cpu_kind: "performance", cpus: 1, memory_mb: 2048 },
  high: { cpu_kind: "performance", cpus: 2, memory_mb: 4096 },
}

function envInt(name: string, dflt: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : dflt
}

function log(msg: string): void {
  process.stdout.write(`[pool-serve] ${msg}\n`)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8")
      if (!raw.trim()) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    req.on("error", reject)
  })
}

/**
 * Parse a slim claim request from the dashboard. Carries NO secrets — the
 * owner resolves the repo's Fly token + provider keys from its vault and the
 * GitHub clone token from the operator env.
 */
export function parseClaimRequest(body: unknown): { req: ClaimRequest } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" }
  const b = body as Record<string, unknown>
  const jobId = typeof b.jobId === "string" ? b.jobId.trim() : ""
  if (!jobId) return { error: "jobId required" }
  const repo = typeof b.repo === "string" ? b.repo.trim() : ""
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return { error: "repo must be 'owner/name'" }

  const mode = b.mode === "interactive" ? "interactive" : b.mode === "scheduled" ? "scheduled" : "issue"
  const req: ClaimRequest = { jobId, repo, mode }
  if (mode === "issue") {
    const issueNumber = Number(b.issueNumber)
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) return { error: "issueNumber required for issue mode" }
    req.issueNumber = issueNumber
  } else if (mode === "interactive") {
    const sessionId = typeof b.sessionId === "string" ? b.sessionId.trim() : ""
    if (!sessionId) return { error: "sessionId required for interactive mode" }
    req.sessionId = sessionId
    if (Number.isFinite(Number(b.idleExitMs))) req.idleExitMs = Number(b.idleExitMs)
    if (Number.isFinite(Number(b.hardCapMs))) req.hardCapMs = Number(b.hardCapMs)
  }
  // mode "scheduled" needs no extra fields — runs the whole agentResponsibility/goal fan-out.
  if (typeof b.ref === "string" && b.ref.trim()) req.ref = b.ref.trim()
  if (typeof b.model === "string" && b.model.trim()) req.model = b.model.trim()
  if (typeof b.sessionId === "string" && b.sessionId.trim()) req.sessionId = b.sessionId.trim()
  if (typeof b.dashboardUrl === "string" && b.dashboardUrl.trim()) req.dashboardUrl = b.dashboardUrl.trim()
  return { req }
}

export async function poolServe(): Promise<number> {
  const masterRaw = process.env.KODY_MASTER_KEY?.trim()
  if (!masterRaw) throw new Error("KODY_MASTER_KEY required for pool-serve")
  // The owner reads each repo's vault to get THAT repo's FLY_API_TOKEN (so its
  // pool runs in its own Fly account) and to clone — it needs a GitHub token,
  // not a global Fly token.
  const githubToken = process.env.GITHUB_TOKEN?.trim()
  if (!githubToken) throw new Error("GITHUB_TOKEN required for pool-serve (reads per-repo vaults)")

  const master = masterKeyBytes(masterRaw)
  const poolApiKey = derivePoolApiKey(master)
  const runnerApiKey = deriveRunnerApiKey(master)

  // NOTE: do NOT read FLY_APP_NAME here — Fly auto-injects the pool owner's
  // app name. POOL_RUNNER_APP is the canonical runner-app name (it must exist
  // in each repo-owner's Fly account).
  const app = process.env.POOL_RUNNER_APP ?? "kody-runner"
  const region = process.env.POOL_REGION ?? "fra"
  const perf = (process.env.POOL_PERF ?? "medium") as keyof typeof PERF_GUEST
  const guest = PERF_GUEST[perf] ?? PERF_GUEST.medium
  const min = envInt("POOL_MIN", 2)
  const runnerPort = envInt("RUNNER_PORT", 8080)
  const apiPort = envInt("POOL_API_PORT", 4100)
  const healthTimeoutMs = envInt("POOL_HEALTH_TIMEOUT_MS", 120_000)

  // One pool per repo, each created with that repo's own vault Fly token.
  const registry = new PoolRegistry({
    githubToken,
    masterKey: master,
    base: {
      min,
      image: process.env.FLY_RUNNER_IMAGE ?? "registry.fly.io/kody-runner:latest",
      region,
      guest,
      runnerApiKey,
      port: runnerPort,
      healthTimeoutMs,
      app,
    },
    log,
  })

  // Periodic self-heal across every active repo pool: prune vanished machines,
  // adopt orphans, top up — no restart needed after manual ops / auto-destroys.
  const refillMs = envInt("POOL_REFILL_INTERVAL_MS", 60_000)
  const tick = setInterval(() => {
    registry.resyncAll().catch((err) => log(`resync tick failed: ${err instanceof Error ? err.message : String(err)}`))
  }, refillMs)

  // GitHub-outage fallback: GitHub Actions' cron normally fires the scheduled
  // agentResponsibility/goal fan-out. When Actions is down that cron can't fire, so while this
  // always-on machine is awake we tick every 15 min and — ONLY if GitHub is
  // degraded — run the fan-out on a Fly runner per active repo. GitHub stays
  // the default; the engine's per-agentResponsibility cadence guard prevents double-runs.
  // Set POOL_AGENT_RESPONSIBILITY_TICK=0 to disable.
  const dutyTickEnabled = (process.env.POOL_AGENT_RESPONSIBILITY_TICK ?? "1") !== "0"
  const dutyTickMs = envInt("POOL_AGENT_RESPONSIBILITY_TICK_MS", 15 * 60_000)
  const dutyTick = dutyTickEnabled
    ? setInterval(() => {
        runAgentResponsibilityFallbackTick({
          isDegraded: () => gitHubActionsDegraded(),
          activeRepos: () => registry.activeRepos(),
          claim: (owner, repo, req) => registry.claim(owner, repo, req),
          log,
        }).catch((err) => log(`agentResponsibility fallback tick failed: ${err instanceof Error ? err.message : String(err)}`))
      }, dutyTickMs)
    : null

  const server = createServer(async (req, res) => {
    try {
      if (!req.method || !req.url) return sendJson(res, 400, { error: "bad request" })
      const url = new URL(req.url, "http://localhost")

      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, {
          ok: true,
          repos: registry.activeRepos(),
        })
      }

      const authed = bearerOk(
        req.headers.authorization as string | undefined,
        req.headers["x-api-key"] as string | undefined,
        poolApiKey,
      )
      if (!authed) return sendJson(res, 401, { error: "unauthorized" })

      // Per-repo status: GET /pool/status?repo=owner/name
      if (req.method === "GET" && url.pathname === "/pool/status") {
        const repoParam = (url.searchParams.get("repo") ?? "").trim()
        const [owner, repo] = repoParam.split("/")
        if (!owner || !repo) return sendJson(res, 400, { error: "repo query (owner/name) required" })
        return sendJson(res, 200, { status: await registry.statusFor(owner, repo) })
      }

      if (req.method === "POST" && url.pathname === "/pool/claim") {
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          return sendJson(res, 400, { error: "invalid JSON body" })
        }
        const parsed = parseClaimRequest(body)
        if ("error" in parsed) return sendJson(res, 400, { error: parsed.error })
        const [owner, repo] = parsed.req.repo.split("/")
        const result = await registry.claim(owner!, repo!, parsed.req)
        if (result.ok) return sendJson(res, 200, { ok: true, machineId: result.machineId })
        // 503 → the dashboard falls back to create-fresh.
        return sendJson(res, 503, { ok: false, reason: result.reason ?? "pool unavailable" })
      }

      return sendJson(res, 404, { error: "not found" })
    } catch (err) {
      // Never let a handler bug crash the process.
      process.stderr.write(`[pool-serve] handler error: ${err instanceof Error ? err.message : String(err)}\n`)
      try {
        sendJson(res, 500, { error: "internal error" })
      } catch {
        /* response already started */
      }
    }
  })

  // Bind IPv6 dual-stack ("::"), NOT 0.0.0.0. Fly's edge proxy reaches the
  // service over the IPv6 6PN network, so an IPv4-only listener makes the
  // public endpoint (443 → 4100) unreachable even though localhost works.
  const apiHost = process.env.POOL_API_HOST ?? "::"
  await new Promise<void>((resolve) => {
    server.listen(apiPort, apiHost, () => {
      log(`listening on ${apiHost}:${apiPort} (min=${min}, app=${app}, region=${region})`)
      resolve()
    })
  })

  const shutdown = (signal: string) => {
    log(`${signal} — shutting down`)
    clearInterval(tick)
    if (dutyTick) clearInterval(dutyTick)
    server.close(() => process.exit(0))
  }
  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))

  await new Promise<void>(() => {
    /* never resolves */
  })
  return 0 // unreachable; satisfies the Promise<number> return type
}
