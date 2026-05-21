/**
 * runnerServe — preflight for the `runner-serve` executable.
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
 * LiteLLM: the always-on proxy forward (localhost:4000 → KODY_LITELLM_URL) is
 * set up once at boot by entrypoint-serve.sh, so per-job spawn is skipped.
 */

import { spawn } from "node:child_process"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import * as fs from "node:fs"

import type { PreflightScript } from "../executables/types.js"

export const DEFAULT_PORT = 8080
const DEFAULT_WORKDIR = "/workspace/repo"

export interface RunnerJob {
  jobId: string
  repo: string
  issueNumber: number
  githubToken: string
  ref?: string
  /** Provider keys etc. (mirrors GH Actions toJSON(secrets)). Object or JSON string. */
  allSecrets?: Record<string, string> | string
  model?: string
  sessionId?: string
  /** Event-ingest URL with inline ?token=... (engine streams events here). */
  dashboardUrl?: string
}

function getApiKey(): string {
  const key = (process.env.RUNNER_API_KEY ?? "").trim()
  if (!key) {
    throw new Error(
      "RUNNER_API_KEY env var is required — set it on the pooled machine before boot.",
    )
  }
  return key
}

export function authOk(req: IncomingMessage, expected: string): boolean {
  const xApiKey = (req.headers["x-api-key"] as string | undefined)?.trim()
  if (xApiKey && xApiKey === expected) return true
  const auth = (req.headers["authorization"] as string | undefined)?.trim()
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
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

  const issueNumber = Number(b.issueNumber)
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { error: "issueNumber (positive integer) required" }
  }

  const githubToken = typeof b.githubToken === "string" ? b.githubToken.trim() : ""
  if (!githubToken) return { error: "githubToken required" }

  const job: RunnerJob = { jobId, repo, issueNumber, githubToken }
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

  const allSecrets =
    typeof job.allSecrets === "string"
      ? job.allSecrets
      : JSON.stringify(job.allSecrets ?? {})

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REPO: job.repo,
    REF: branch,
    GITHUB_TOKEN: job.githubToken,
    ISSUE_NUMBER: String(job.issueNumber),
    ALL_SECRETS: allSecrets,
    SESSION_ID: job.sessionId ?? "",
    DASHBOARD_URL: job.dashboardUrl ?? "",
    MODEL: job.model ?? "",
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
  const cloneCode = await run("git", [
    "clone",
    "--depth=1",
    "--single-branch",
    "--branch",
    branch,
    authUrl,
    workdir,
  ])
  if (cloneCode !== 0) {
    process.stderr.write(`[runner-serve] job ${job.jobId}: clone failed (${cloneCode})\n`)
    process.exit(cloneCode)
    return
  }

  process.stdout.write(`[runner-serve] job ${job.jobId}: running issue #${job.issueNumber}\n`)
  const runCode = await run("kody", ["run", "--issue", String(job.issueNumber)], workdir)
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

export const runnerServe: PreflightScript = async (ctx) => {
  ctx.skipAgent = true

  const apiKey = getApiKey()
  const port = Number(process.env.PORT ?? DEFAULT_PORT)

  const server = buildServer({ apiKey })

  await new Promise<void>((resolve) => {
    server.listen(port, "0.0.0.0", () => {
      process.stdout.write(`[runner-serve] listening on 0.0.0.0:${port} (idle, awaiting job)\n`)
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
}
