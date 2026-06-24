/**
 * runnerServe — preflight for the `runner-serve` agentAction.
 *
 * Idle HTTP server for a WARM-POOL one-shot runner. A pooled machine boots
 * into this mode with NO issue baked in, starts the listener, and is then
 * frozen (Fly suspend) by the pool owner. On claim the owner wakes it (~1s)
 * and POSTs a single job; the server clones the repo and spawns the existing
 * `kody run --issue N` path, then exits so Fly's auto_destroy tears the
 * machine down. The pool owner refills.
 *
 * This exists because a frozen machine's boot env can't change — so the
 * issue/repo/token must arrive AFTER wake, over HTTP, instead of at boot.
 * Mirrors brainServe.ts (the chat equivalent): same auth, same minimal
 * node:http server, no agent invocation (ctx.skipAgent).
 *
 * Endpoints:
 *   GET  /healthz        — 200 { ok, busy } (no auth; Fly health + pool probe)
 *   POST /run            — auth: X-Api-Key / Bearer $RUNNER_API_KEY.
 *                          body: { jobId, repo, issueNumber, githubToken,
 *                                  ref?, allSecrets?, model?, sessionId?,
 *                                  dashboardUrl? }
 *                          202 once accepted; the job runs detached and the
 *                          process exits on completion. 409 if already busy
 *                          (a pooled runner handles exactly one job).
 *
 * LiteLLM: each accepted job uses the normal runner path, which prewarms or
 * starts a local proxy from that repo's secrets.
 */

import { spawn } from "node:child_process"
import * as fs from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

export const DEFAULT_PORT = 8080
const DEFAULT_WORKDIR = "/workspace/repo"

export interface RunnerJob {
  jobId: string
  repo: string
  githubToken: string
  /**
   * "issue" (default): one-shot `kody run --issue N` → branch → PR → exit.
   * "interactive": boot a long-lived `kody` chat session (the Vibe runner) —
   * emits chat.ready, takes turns via the dashboard's append/event path.
   * "scheduled": run the scheduled fan-out (`GITHUB_EVENT_NAME=schedule`) —
   * the same agentResponsibility/goal tick GitHub Actions' cron triggers, used as the Fly
   * fallback when GitHub Actions is down. No issueNumber/sessionId needed.
   */
  mode?: "issue" | "interactive" | "scheduled"
  /** Required for mode "issue". */
  issueNumber?: number
  /** Required for mode "interactive" — the chat session id. */
  sessionId?: string
  /** Interactive idle/hard-cap (ms) — mirrors spawnRunner. */
  idleExitMs?: number
  hardCapMs?: number
  ref?: string
  /** Provider keys etc. (mirrors GH Actions toJSON(secrets)). Object or JSON string. */
  allSecrets?: Record<string, string> | string
  model?: string
  /** Event-ingest URL with inline ?token=... (engine streams events here). */
  dashboardUrl?: string
}

function getApiKey(): string {
  const key = (process.env.RUNNER_API_KEY ?? "").trim()
  if (!key) {
    throw new Error("RUNNER_API_KEY env var is required — set it on the pooled machine before boot.")
  }
  return key
}

export function authOk(req: IncomingMessage, expected: string): boolean {
  const xApiKey = (req.headers["x-api-key"] as string | undefined)?.trim()
  if (xApiKey && xApiKey === expected) return true
  const auth = (req.headers.authorization as string | undefined)?.trim()
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() === expected
  }
  return false
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8")
      if (!raw.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    req.on("error", reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

/**
 * Validate an untrusted POST /run body into a RunnerJob, or return an error
 * string. Kept pure for tests.
 */
export function parseJob(body: unknown): { job: RunnerJob } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" }
  const b = body as Record<string, unknown>

  const jobId = typeof b.jobId === "string" ? b.jobId.trim() : ""
  if (!jobId) return { error: "jobId required" }

  const repo = typeof b.repo === "string" ? b.repo.trim() : ""
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return { error: "repo must be 'owner/name'" }

  const githubToken = typeof b.githubToken === "string" ? b.githubToken.trim() : ""
  if (!githubToken) return { error: "githubToken required" }

  const mode = b.mode === "interactive" ? "interactive" : b.mode === "scheduled" ? "scheduled" : "issue"
  const job: RunnerJob = { jobId, repo, githubToken, mode }

  if (mode === "issue") {
    const issueNumber = Number(b.issueNumber)
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return { error: "issueNumber (positive integer) required for issue mode" }
    }
    job.issueNumber = issueNumber
  } else if (mode === "interactive") {
    const sessionId = typeof b.sessionId === "string" ? b.sessionId.trim() : ""
    if (!sessionId) return { error: "sessionId required for interactive mode" }
    job.sessionId = sessionId
    if (Number.isFinite(Number(b.idleExitMs))) job.idleExitMs = Number(b.idleExitMs)
    if (Number.isFinite(Number(b.hardCapMs))) job.hardCapMs = Number(b.hardCapMs)
  }
  // mode "scheduled" needs no extra fields — it runs the whole fan-out.

  if (typeof b.ref === "string" && b.ref.trim()) job.ref = b.ref.trim()
  if (typeof b.model === "string" && b.model.trim()) job.model = b.model.trim()
  if (typeof b.sessionId === "string" && b.sessionId.trim()) job.sessionId = b.sessionId.trim()
  if (typeof b.dashboardUrl === "string" && b.dashboardUrl.trim()) job.dashboardUrl = b.dashboardUrl.trim()
  if (b.allSecrets && (typeof b.allSecrets === "object" || typeof b.allSecrets === "string")) {
    job.allSecrets = b.allSecrets as Record<string, string> | string
  }
  return { job }
}

/**
 * Default job runner: clone the repo, spawn `kody run --issue N`, and exit
 * the process with the child's code so Fly auto_destroy reclaims the machine.
 * Replaceable in tests via buildServer({ runJob }).
 */
async function defaultRunJob(job: RunnerJob): Promise<void> {
  const workdir = process.env.RUNNER_WORKDIR ?? DEFAULT_WORKDIR
  const branch = job.ref ?? "main"
  const authUrl = `https://x-access-token:${job.githubToken}@github.com/${job.repo}.git`

  fs.rmSync(workdir, { recursive: true, force: true })
  fs.mkdirSync(workdir, { recursive: true })

  const allSecrets = typeof job.allSecrets === "string" ? job.allSecrets : JSON.stringify(job.allSecrets ?? {})

  const interactive = job.mode === "interactive"
  const scheduled = job.mode === "scheduled"
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REPO: job.repo,
    REF: branch,
    GITHUB_TOKEN: job.githubToken,
    // Scheduled mode drives the engine down the same path GitHub Actions' cron
    // takes (runScheduledFanOut → due agentResponsibilities/goals). Bare `kody` routes on this.
    ...(scheduled ? { GITHUB_EVENT_NAME: "schedule" } : {}),
    // GITHUB_REPOSITORY + GH_TOKEN are normally injected by GitHub Actions.
    // The engine's interactive mode needs GITHUB_REPOSITORY to persist
    // chat.ready / events to .kody/events via the Contents API (the durable
    // signal the dashboard polls for readiness) — without it commitTurn bails
    // and the session never appears "ready". GH_TOKEN auths the `gh` CLI.
    GITHUB_REPOSITORY: job.repo,
    GH_TOKEN: job.githubToken,
    // Issue mode bakes ISSUE_NUMBER → `kody run --issue N`. Interactive mode
    // leaves it empty and sets SESSION_ID so the engine boots a chat session.
    ISSUE_NUMBER: interactive || scheduled ? "" : String(job.issueNumber),
    ALL_SECRETS: allSecrets,
    SESSION_ID: job.sessionId ?? "",
    DASHBOARD_URL: job.dashboardUrl ?? "",
    MODEL: job.model ?? "",
    ...(interactive && job.idleExitMs ? { KODY_IDLE_EXIT_MS: String(job.idleExitMs) } : {}),
    ...(interactive && job.hardCapMs ? { KODY_HARD_CAP_MS: String(job.hardCapMs) } : {}),
  }

  const run = (cmd: string, args: string[], cwd?: string) =>
    new Promise<number>((resolve) => {
      const child = spawn(cmd, args, { stdio: "inherit", env: childEnv, cwd })
      child.on("exit", (code) => resolve(code ?? 0))
      child.on("error", (err) => {
        process.stderr.write(`[runner-serve] ${cmd} failed: ${err.message}\n`)
        resolve(1)
      })
    })

  process.stdout.write(`[runner-serve] job ${job.jobId}: cloning ${job.repo}@${branch}\n`)
  const cloneCode = await run("git", ["clone", "--depth=1", "--single-branch", "--branch", branch, authUrl, workdir])
  if (cloneCode !== 0) {
    process.stderr.write(`[runner-serve] job ${job.jobId}: clone failed (${cloneCode})\n`)
    process.exit(cloneCode)
    return
  }

  // Configure the git committer identity — without it `git commit` in the
  // engine's postflight fails ("Please tell me who you are") and the agent's
  // changes are never committed/pushed (no PR). The one-shot entrypoint.sh
  // does the same after cloning.
  const authorName = process.env.GIT_AUTHOR_NAME ?? "Kody Bot"
  const authorEmail = process.env.GIT_AUTHOR_EMAIL ?? "kody-bot@users.noreply.github.com"
  await run("git", ["config", "user.name", authorName], workdir)
  await run("git", ["config", "user.email", authorEmail], workdir)

  // Issue mode: one-shot `kody run --issue N`. Interactive + scheduled modes:
  // bare `kody`, routed by env — SESSION_ID → chat session (Vibe runner), or
  // GITHUB_EVENT_NAME=schedule → the scheduled agentResponsibility/goal fan-out.
  const runArgs = interactive || scheduled ? [] : ["run", "--issue", String(job.issueNumber)]
  const jobDesc = interactive
    ? `interactive session ${job.sessionId}`
    : scheduled
      ? "scheduled fan-out"
      : `running issue #${job.issueNumber}`
  process.stdout.write(`[runner-serve] job ${job.jobId}: ${jobDesc}\n`)
  const runCode = await run("kody", runArgs, workdir)
  process.stdout.write(`[runner-serve] job ${job.jobId}: finished (exit ${runCode})\n`)
  process.exit(runCode)
}

export interface BuildRunnerServerOptions {
  apiKey: string
  /** Seam for tests — defaults to clone + `kody run`. */
  runJob?: (job: RunnerJob) => Promise<void>
}

export function buildServer(opts: BuildRunnerServerOptions): Server {
  const runJob = opts.runJob ?? defaultRunJob
  // A pooled runner is single-shot: it accepts exactly one job, then the
  // process exits and the machine auto-destroys. Reject concurrent claims.
  let busy = false

  return createServer(async (req, res) => {
    if (!req.method || !req.url) {
      sendJson(res, 400, { error: "bad request" })
      return
    }
    const url = new URL(req.url, "http://localhost")

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, busy })
      return
    }

    if (!authOk(req, opts.apiKey)) {
      sendJson(res, 401, { error: "unauthorized" })
      return
    }

    if (req.method === "POST" && url.pathname === "/run") {
      if (busy) {
        sendJson(res, 409, { error: "runner busy" })
        return
      }
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" })
        return
      }
      const parsed = parseJob(body)
      if ("error" in parsed) {
        sendJson(res, 400, { error: parsed.error })
        return
      }
      busy = true
      // Accept now; the job runs detached and streams events to dashboardUrl.
      sendJson(res, 202, { ok: true, jobId: parsed.job.jobId, started: true })
      void runJob(parsed.job).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[runner-serve] job ${parsed.job.jobId} crashed: ${msg}\n`)
        process.exit(1)
      })
      return
    }

    sendJson(res, 404, { error: "not found" })
  })
}

export async function runnerServe(): Promise<number> {
  const apiKey = getApiKey()
  const port = Number(process.env.PORT ?? DEFAULT_PORT)

  const server = buildServer({ apiKey })

  // Bind IPv6 dual-stack ("::"), NOT 0.0.0.0. The pool owner reaches this
  // machine over Fly's IPv6-only 6PN network (http://[fdaa:...]:PORT), so an
  // IPv4-only listener is unreachable and the machine never passes the pool's
  // health check. "::" on Linux also accepts IPv4-mapped localhost checks.
  const host = process.env.RUNNER_HOST ?? "::"
  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      process.stdout.write(`[runner-serve] listening on ${host}:${port} (idle, awaiting job)\n`)
      resolve()
    })
  })

  const shutdown = (signal: string) => {
    process.stdout.write(`[runner-serve] ${signal} — shutting down\n`)
    server.close(() => process.exit(0))
  }
  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))

  // Block forever — the executor would otherwise return and exit the process.
  await new Promise<void>(() => {
    /* never resolves */
  })
  return 0 // unreachable; satisfies the Promise<number> return type
}
