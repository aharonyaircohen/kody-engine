/**
 * Preflight: serve the checked-out PR branch on localhost so ui-review can
 * browse it without depending on Vercel (or any third-party preview host).
 *
 * Runs AFTER `reviewFlow` (which checks out the PR branch) and BEFORE
 * `resolvePreviewUrl` (which would otherwise hit the GitHub Deployments
 * API for a Vercel preview). When this preflight succeeds, it exports
 * `process.env.PREVIEW_URL=http://localhost:<port>` so `resolvePreviewUrl`
 * picks it up via its "env" branch.
 *
 * Skips when:
 *   - --preview-url flag is set (caller knows the URL)
 *   - process.env.PREVIEW_URL is already populated upstream
 *   - package.json is missing or has no dev/start script
 *
 * Picks `dev` over `start` (faster, no build step). Detects pnpm/yarn/npm
 * from the lockfile. Polls the URL until it returns non-5xx or times out.
 * Child process is reaped on parent exit; the runner reaps anything we miss.
 *
 * Populates:
 *   ctx.data.qaServerPid     — PID of the spawned server (informational)
 *   ctx.data.qaServerScript  — name of the npm script that was run
 *   process.env.PREVIEW_URL  — URL the agent will browse
 */

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { PreflightScript } from "../executables/types.js"

const READY_TIMEOUT_MS = 120_000
const READY_POLL_MS = 1_000
const INSTALL_TIMEOUT_MS = 300_000
const FETCH_TIMEOUT_MS = 2_000
const DEFAULT_PORT = 3000

type PackageManager = "pnpm" | "yarn" | "npm"

export const startLocalServer: PreflightScript = async (ctx) => {
  if (urlAlreadyResolved(ctx)) {
    process.stderr.write("[kody startLocalServer] preview URL already set — skipping\n")
    return
  }

  const pkg = readPackageJson(ctx.cwd)
  if (!pkg) return

  const scriptName = pickScript(pkg.scripts)
  if (!scriptName) {
    process.stderr.write("[kody startLocalServer] no dev/start script in package.json — skipping\n")
    return
  }

  const pm = detectPackageManager(ctx.cwd)
  const port = pickPort()

  await ensureDependenciesInstalled(pm, ctx.cwd)

  const url = `http://localhost:${port}`
  process.stderr.write(`[kody startLocalServer] spawning '${pm} run ${scriptName}' on ${url}\n`)
  const child = spawnServer(pm, scriptName, port, ctx.cwd)

  registerProcessCleanup(child)

  const ready = await waitForReady(url, READY_TIMEOUT_MS)
  if (!ready) {
    safeKill(child)
    throw new Error(
      `startLocalServer: dev server at ${url} did not become reachable within ${READY_TIMEOUT_MS}ms`,
    )
  }

  process.env.PREVIEW_URL = url
  ctx.data.qaServerPid = child.pid
  ctx.data.qaServerScript = scriptName
  process.stderr.write(`[kody startLocalServer] ready: ${url}\n`)
}

interface PackageJson {
  scripts: Record<string, string>
}

function urlAlreadyResolved(ctx: { args: Record<string, unknown> }): boolean {
  const fromFlag = typeof ctx.args.previewUrl === "string" ? (ctx.args.previewUrl as string).trim() : ""
  if (fromFlag.length > 0) return true
  const fromEnv = (process.env.PREVIEW_URL ?? "").trim()
  return fromEnv.length > 0
}

function readPackageJson(cwd: string): PackageJson | null {
  const path = join(cwd, "package.json")
  if (!existsSync(path)) {
    process.stderr.write("[kody startLocalServer] no package.json — skipping\n")
    return null
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, string> }
    return { scripts: raw.scripts ?? {} }
  } catch (err) {
    process.stderr.write(
      `[kody startLocalServer] could not parse package.json: ${(err as Error).message}\n`,
    )
    return null
  }
}

function pickScript(scripts: Record<string, string>): string | null {
  if (typeof scripts.dev === "string" && scripts.dev.length > 0) return "dev"
  if (typeof scripts.start === "string" && scripts.start.length > 0) return "start"
  return null
}

function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn"
  return "npm"
}

function pickPort(): number {
  const fromEnv = Number((process.env.PREVIEW_PORT ?? "").trim())
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  return DEFAULT_PORT
}

async function ensureDependenciesInstalled(pm: PackageManager, cwd: string): Promise<void> {
  if (existsSync(join(cwd, "node_modules"))) return
  process.stderr.write(`[kody startLocalServer] installing dependencies via ${pm}\n`)
  await runOnce(pm, installArgs(pm), cwd, INSTALL_TIMEOUT_MS)
}

function installArgs(pm: PackageManager): string[] {
  if (pm === "pnpm") return ["install", "--frozen-lockfile"]
  if (pm === "yarn") return ["install", "--frozen-lockfile"]
  return ["ci"]
}

function spawnServer(
  pm: PackageManager,
  scriptName: string,
  port: number,
  cwd: string,
): ReturnType<typeof spawn> {
  const child = spawn(pm, ["run", scriptName], {
    cwd,
    env: { ...process.env, PORT: String(port), NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  })

  child.stdout?.on("data", (b: Buffer) => process.stderr.write(`[qa-server] ${b.toString("utf8")}`))
  child.stderr?.on("data", (b: Buffer) => process.stderr.write(`[qa-server] ${b.toString("utf8")}`))

  return child
}

function registerProcessCleanup(child: ReturnType<typeof spawn>): void {
  const cleanup = (): void => safeKill(child)
  process.on("exit", cleanup)
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)
}

function safeKill(child: ReturnType<typeof spawn>): void {
  try {
    child.kill("SIGTERM")
  } catch {
    /* ignore — runner reaps */
  }
}

async function runOnce(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const c = spawn(cmd, args, { cwd, stdio: "inherit" })
    const timer = setTimeout(() => {
      try {
        c.kill("SIGKILL")
      } catch {
        /* ignore */
      }
      reject(new Error(`${cmd} ${args.join(" ")} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    c.on("exit", (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`))
    })
    c.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function waitForReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe(url)) return true
    await sleep(READY_POLL_MS)
  }
  return false
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    return res.status < 500
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
