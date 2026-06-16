/**
 * Preflight: run a scheduled executable's colocated shell tick.
 *
 * Clean scheduled executable pattern:
 * - duty profile declares `executable`
 * - scheduler passes the duty slug as a CLI arg
 * - executable profile runs this generic script
 * - local `tick.sh` emits a `kody-job-next-state` fenced block
 * - existing `writeJobStateFile` persists state
 */
import * as fs from "node:fs"
import * as path from "node:path"

import { readDutyFolder } from "../dutyFolders.js"
import type { PreflightScript } from "../executables/types.js"
import { resolveBackend } from "./jobState/index.js"
import { runTickShellAndParse } from "./tickShellRunner.js"

export const runScheduledExecutableTick: PreflightScript = async (ctx, profile, args) => {
  ctx.skipAgent = true

  const jobsDir = String(args?.jobsDir ?? ".kody/duties")
  const slugArg = String(args?.slugArg ?? "duty")
  const fenceLabel = String(args?.fenceLabel ?? "kody-job-next-state")
  const shell = String(args?.shell ?? "tick.sh")
  const slug = String(ctx.args[slugArg] ?? "").trim()

  if (!slug) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runScheduledExecutableTick: ctx.args.${slugArg} must be non-empty duty slug`
    return
  }

  const duty = readDutyFolder(path.join(ctx.cwd, jobsDir), slug)
  if (!duty) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runScheduledExecutableTick: duty folder not found or incomplete: ${path.join(jobsDir, slug)}`
    return
  }

  const shellPath = path.join(profile.dir, shell)
  if (!fs.existsSync(shellPath)) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runScheduledExecutableTick: shell not found: ${shell} (looked in ${profile.dir})`
    return
  }

  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  let loaded: Awaited<ReturnType<typeof backend.load>>
  try {
    loaded = await backend.load(slug)
  } catch (err) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runScheduledExecutableTick: state load failed: ${err instanceof Error ? err.message : String(err)}`
    return
  }

  ctx.data.jobSlug = slug
  ctx.data.dutySlug = slug
  ctx.data.executableSlug = profile.name
  ctx.data.jobState = loaded

  runTickShellAndParse({
    ctx,
    loaded,
    scriptPath: shellPath,
    displayName: `runScheduledExecutableTick: ${shell}`,
    fenceLabel,
    force: Boolean(ctx.args.force),
  })
}
