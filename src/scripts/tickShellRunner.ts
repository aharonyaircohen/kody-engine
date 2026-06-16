import { spawnSync } from "node:child_process"

import type { Context } from "../executables/types.js"
import type { LoadedJobState } from "./jobState/index.js"
import { extractNextStateFromText } from "./parseJobStateFromAgentResult.js"

export interface TickShellRunOptions {
  ctx: Context
  loaded: LoadedJobState
  scriptPath: string
  displayName: string
  reasonSubject?: string
  fenceLabel: string
  force: boolean
}

export function runTickShellAndParse(opts: TickShellRunOptions): void {
  const childEnv = buildTickChildEnv(process.env, opts.force)
  const result = spawnSync("bash", [opts.scriptPath], {
    cwd: opts.ctx.cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 5 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  })

  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)

  if (result.error) {
    opts.ctx.output.exitCode = 99
    opts.ctx.output.reason = `${opts.displayName}: spawn error: ${result.error.message}`
    return
  }

  if (result.signal) {
    opts.ctx.output.exitCode = 124
    opts.ctx.output.reason = `${opts.displayName}: ${opts.reasonSubject ? `${opts.reasonSubject} ` : ""}killed by ${result.signal} (likely 5min timeout)`
    return
  }

  if (result.status !== 0) {
    opts.ctx.output.exitCode = result.status ?? 99
    opts.ctx.output.reason = `${opts.displayName}: ${opts.reasonSubject ? `${opts.reasonSubject} ` : ""}exited ${result.status}`
    return
  }

  const prevRev = opts.loaded.state.rev ?? 0
  const parsed = extractNextStateFromText(result.stdout ?? "", opts.fenceLabel, prevRev)
  if (parsed.error) {
    opts.ctx.data.nextStateParseError = parsed.error
    opts.ctx.output.exitCode = 1
    opts.ctx.output.reason = `${opts.displayName}: ${parsed.error}`
    return
  }

  opts.ctx.data.nextJobState = parsed.envelope
}

export function buildTickChildEnv(parent: NodeJS.ProcessEnv, force: boolean): NodeJS.ProcessEnv {
  const allow = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "GH_TOKEN",
    "GH_PAT",
    "GITHUB_TOKEN",
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_WORKFLOW",
    "GITHUB_ACTIONS",
    "CI",
    "KODY_DRY_RUN",
    "KODY_NO_COMMIT",
  ])

  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if (allow.has(key) || key.startsWith("KODY_PUBLIC_")) env[key] = value
  }
  if (force) env.KODY_FORCE = "1"
  return env
}
