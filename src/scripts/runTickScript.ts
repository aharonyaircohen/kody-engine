/**
 * Preflight: deterministic alternative to the LLM-driven job-tick.
 *
 * Reads a job's frontmatter, executes the declared `tickScript:`,
 * captures its stdout, and parses the `kody-job-next-state` fenced
 * block directly into `ctx.data.nextJobState`. No agent runs.
 *
 * This exists because the agent path silently dropped state when the
 * model summarized instead of echoing the script's stdout verbatim,
 * so the per-PR attempt counter never persisted and resolve-style
 * jobs spammed `@kody resolve` indefinitely.
 *
 * Contract:
 *   - Job markdown at `<jobsDir>/<slug>.md` MUST declare `tickScript:`
 *     in frontmatter (relative path under cwd).
 *   - Script MUST emit a `kody-job-next-state` JSON fenced block on
 *     stdout. Anything else on stdout is preserved as run-log noise.
 *   - Non-zero script exit propagates to the executable's exitCode.
 *
 * Reads   ctx.args[<slugArg>]
 * Writes  ctx.data.jobSlug, ctx.data.jobState, ctx.data.nextJobState
 *         (or ctx.data.nextStateParseError on failure)
 *
 * Script args (via `with:`):
 *   jobsDir     optional — default ".kody/jobs"
 *   slugArg     optional — default "job"
 *   fenceLabel  optional — default "kody-job-next-state"
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"
import { splitFrontmatter } from "./jobFrontmatter.js"
import { resolveBackend } from "./jobState/index.js"
import { extractNextStateFromText } from "./parseJobStateFromAgentResult.js"

export const runTickScript: PreflightScript = async (ctx, _profile, args) => {
  ctx.skipAgent = true

  const jobsDir = String(args?.jobsDir ?? ".kody/jobs")
  const slugArg = String(args?.slugArg ?? "job")
  const fenceLabel = String(args?.fenceLabel ?? "kody-job-next-state")
  const slug = String(ctx.args[slugArg] ?? "").trim()
  if (!slug) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runTickScript: ctx.args.${slugArg} must be a non-empty slug`
    return
  }

  const jobPath = path.join(ctx.cwd, jobsDir, `${slug}.md`)
  if (!fs.existsSync(jobPath)) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runTickScript: job file not found: ${jobPath}`
    return
  }

  const raw = fs.readFileSync(jobPath, "utf-8")
  const { frontmatter } = splitFrontmatter(raw)
  const tickScript = frontmatter.tickScript
  if (!tickScript) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runTickScript: job ${slug} has no \`tickScript:\` frontmatter — route via job-tick instead`
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
  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  const loaded = await backend.load(slug)
  ctx.data.jobSlug = slug
  ctx.data.jobState = loaded

  // Inherit the parent env so the script sees GH_TOKEN / GH_PAT and
  // anything else workflows export. Pass cwd so relative paths inside
  // the script (e.g. `STATE_FILE=".kody/jobs/..."`) resolve correctly.
  const result = spawnSync("bash", [scriptPath], {
    cwd: ctx.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 5 * 60 * 1000,
  })

  // Surface stdout/stderr to the caller so logs match the agent path's
  // output for debuggability. Even on parse failure, the operator can
  // see what the script actually produced.
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)

  if (result.error) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runTickScript: spawn error: ${result.error.message}`
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
