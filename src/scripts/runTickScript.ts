/**
 * Preflight: deterministic alternative to the LLM-driven capability-tick.
 *
 * Reads a capability folder's `profile.json`, executes the declared `tickScript`,
 * captures its stdout, and parses the `kody-job-next-state` fenced
 * block directly into `ctx.data.nextJobState`. No agent runs.
 *
 * This exists because the agent path silently dropped state when the
 * model summarized instead of echoing the script's stdout verbatim,
 * so the per-PR attempt counter never persisted and resolve-style
 * jobs spammed `@kody resolve` indefinitely.
 *
 * Contract:
 *   - Capability folder at `<jobsDir>/<slug>/` MUST declare `tickScript` in
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
 *   jobsDir     optional — default ".kody/capabilities"
 *   slugArg     optional — default "job"
 *   fenceLabel  optional — default "kody-job-next-state"
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"
import { readCapabilityFolder } from "../capabilityFolders.js"
import { resolveBackend } from "./jobState/index.js"
import { runTickShellAndParse } from "./tickShellRunner.js"

export const runTickScript: PreflightScript = async (ctx, _profile, args) => {
  ctx.skipAgent = true

  const jobsDir = String(args?.jobsDir ?? ".kody/capabilities")
  const slugArg = String(args?.slugArg ?? "job")
  const fenceLabel = String(args?.fenceLabel ?? "kody-job-next-state")
  const slug = String(ctx.args[slugArg] ?? "").trim()
  if (!slug) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runTickScript: ctx.args.${slugArg} must be a non-empty slug`
    return
  }

  const capability = readCapabilityFolder(path.join(ctx.cwd, jobsDir), slug)
  if (!capability) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runTickScript: capability folder not found or incomplete: ${path.join(ctx.cwd, jobsDir, slug)}`
    return
  }

  const tickScript = capability.config.tickScript
  if (!tickScript) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runTickScript: capability ${slug} has no \`tickScript\` in profile.json — route via capability-tick instead`
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

  runTickShellAndParse({
    ctx,
    loaded,
    scriptPath,
    displayName: "runTickScript",
    reasonSubject: tickScript,
    fenceLabel,
    force: Boolean(ctx.args.force),
  })
}
