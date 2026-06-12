/**
 * Preflight: deterministic alternative to the LLM-driven duty-tick.
 *
 * Reads a duty folder's `profile.json`, executes the declared `tickScript`,
 * captures its stdout, and parses the `kody-job-next-state` fenced
 * block directly into `ctx.data.nextJobState`. No agent runs.
 *
 * This exists because the agent path silently dropped state when the
 * model summarized instead of echoing the script's stdout verbatim,
 * so the per-PR attempt counter never persisted and resolve-style
 * jobs spammed `@kody resolve` indefinitely.
 *
 * Contract:
 *   - Duty folder at `<jobsDir>/<slug>/` MUST declare `tickScript` in
 *     `profile.json` (relative path under cwd).
 *   - Script MUST emit a `kody-job-next-state` JSON fenced block on
 *     stdout. Anything else on stdout is preserved as run-log noise.
 *   - Non-zero script exit propagates to the executable's exitCode.
 *
 * Reads   ctx.args[<slugArg>]
 * Writes  ctx.data.jobSlug, ctx.data.jobState, ctx.data.nextJobState
 *         (or ctx.data.nextStateParseError on failure)
 *
 * Script args (via `with:`):
 *   jobsDir     optional — default ".kody/duties"
 *   slugArg     optional — default "job"
 *   fenceLabel  optional — default "kody-job-next-state"
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { readDutyFolder } from "../dutyFolders.js"
import type { PreflightScript } from "../executables/types.js"
import { resolveBackend } from "./jobState/index.js"
import { extractNextStateFromText } from "./parseJobStateFromAgentResult.js"

export const runTickScript: PreflightScript = async (ctx, _profile, args) => {
  ctx.skipAgent = true

  const jobsDir = String(args?.jobsDir ?? ".kody/duties")
  const slugArg = String(args?.slugArg ?? "job")
  const fenceLabel = String(args?.fenceLabel ?? "kody-job-next-state")
  const slug = String(ctx.args[slugArg] ?? "").trim()
  if (!slug) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runTickScript: ctx.args.${slugArg} must be a non-empty slug`
    return
  }

  const duty = readDutyFolder(path.join(ctx.cwd, jobsDir), slug)
  if (!duty) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runTickScript: duty folder not found or incomplete: ${path.join(ctx.cwd, jobsDir, slug)}`
    return
  }

  const tickScript = duty.config.tickScript
  if (!tickScript) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runTickScript: duty ${slug} has no \`tickScript\` in profile.json — route via duty-tick instead`
    return
  }

  const scriptPath = path.isAbsolute(tickScript) ? tickScript : path.join(ctx.cwd, tickScript)
  if (!fs.existsSync(scriptPath)) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runTickScript: tickScript not found: ${scriptPath}`
    return
  }

  // Backend-agnostic load — same shape `loadJobFromFile` produces, so
  // `writeJobStateFile` can persist via the configured backend below.
  // Wrap in try/catch: contents-API backend shells out to `gh api`, which
  // can throw on a network blip / 403 — we'd rather surface a clean
  // exitCode than dump a raw stack into the run log.
  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  let loaded: Awaited<ReturnType<typeof backend.load>>
  try {
    loaded = await backend.load(slug)
  } catch (err) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runTickScript: state load failed: ${err instanceof Error ? err.message : String(err)}`
    return
  }
  ctx.data.jobSlug = slug
  ctx.data.jobState = loaded

  // Curated env — do NOT pass `process.env` wholesale. Workflow runners
  // hold KODY_MASTER_KEY, GitHub OAuth secrets, model API keys, etc.;
  // a script with `set -x` would echo any of those into stdout/logs. The
  // allow-list covers what tick scripts actually need: PATH for binaries,
  // HOME/locale for tools that read them, GH_TOKEN/GH_PAT for `gh`, and
  // the GITHUB_* vars CI runners expose.
  // Also forwards KODY_FORCE so scripts can branch on the manual "Run now"
  // button (parity with the `force` input declared on the profile).
  const childEnv = buildChildEnv(process.env, Boolean(ctx.args.force))
  const result = spawnSync("bash", [scriptPath], {
    cwd: ctx.cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 5 * 60 * 1000,
    // Default maxBuffer is 1MB — a chatty `gh pr list --json …` over a
    // busy repo (or an accidental `set -x`) can blow that and silently
    // truncate stdout, which is the exact "silent state drop" failure
    // mode this whole executable was written to prevent. 16MB is well
    // above any realistic tick output.
    maxBuffer: 16 * 1024 * 1024,
  })

  // Surface stdout/stderr to the caller so logs match the agent path's
  // output for debuggability. Even on parse failure, the operator can
  // see what the script actually produced. Note: stdio is "pipe" (we
  // captured to result.std{out,err}); this single write is the only
  // surfacing — do NOT change to "inherit" or output will double-print
  // on tty.
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)

  if (result.error) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runTickScript: spawn error: ${result.error.message}`
    return
  }
  // Timeout: spawnSync sets `signal` (typically "SIGTERM") and leaves
  // status=null. Without this branch the operator sees "exited null"
  // and can't tell hung-script from exec-failure.
  if (result.signal) {
    ctx.output.exitCode = 124
    ctx.output.reason = `runTickScript: ${tickScript} killed by ${result.signal} (likely 5min timeout)`
    return
  }
  if (result.status !== 0) {
    ctx.output.exitCode = result.status ?? 99
    ctx.output.reason = `runTickScript: ${tickScript} exited ${result.status}`
    return
  }

  const prevRev = loaded.state.rev ?? 0
  const parsed = extractNextStateFromText(result.stdout ?? "", fenceLabel, prevRev)
  if (parsed.error) {
    ctx.data.nextStateParseError = parsed.error
    ctx.output.exitCode = 1
    ctx.output.reason = `runTickScript: ${parsed.error}`
    return
  }
  ctx.data.nextJobState = parsed.envelope
}

/**
 * Build a curated child env for the tick script. Allow-list covers what
 * tick scripts actually need; everything else (vault keys, OAuth
 * secrets, dashboard session secrets) is dropped so a script with
 * `set -x` can't echo them into stdout/logs.
 *
 * Any var prefixed `KODY_PUBLIC_` is also forwarded — that prefix is
 * the contract for "safe to expose to job scripts" (mirrors Next.js's
 * NEXT_PUBLIC_ convention).
 */
function buildChildEnv(parent: NodeJS.ProcessEnv, force: boolean): NodeJS.ProcessEnv {
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
    // GitHub auth — `gh` reads these.
    "GH_TOKEN",
    "GH_PAT",
    "GITHUB_TOKEN",
    // CI metadata commonly read by tick scripts (`gh repo view`,
    // workflow run links, etc.). All public values from GitHub Actions.
    "GITHUB_ACTIONS",
    "GITHUB_ACTOR",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_OWNER",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_NUMBER",
    "GITHUB_WORKFLOW",
    "GITHUB_JOB",
    "GITHUB_SERVER_URL",
    "GITHUB_API_URL",
    "GITHUB_EVENT_NAME",
    "RUNNER_OS",
    "RUNNER_ARCH",
  ])

  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if (allow.has(key) || key.startsWith("KODY_PUBLIC_")) {
      out[key] = value
    }
  }
  if (force) out.KODY_FORCE = "1"
  return out
}
