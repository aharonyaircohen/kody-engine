/**
 * Preflight: run a scheduled implementation's colocated shell tick.
 *
 * Clean scheduled implementation pattern:
 * - capability profile declares `implementation`
 * - scheduler passes the capability slug as a CLI arg
 * - implementation profile runs this generic script
 * - local `tick.sh` emits a `kody-job-next-state` fenced block
 * - existing `writeJobStateFile` persists state
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { capabilitiesRoot } from "../definition-paths.js"
import type { PreflightScript } from "../implementations/types.js"
import { resolveCapabilityFolder } from "../registry.js"
import { resolveBackend } from "./jobState/index.js"
import { runTickShellAndParse } from "./tickShellRunner.js"

export const runScheduledImplementationTick: PreflightScript = async (ctx, profile, args) => {
  ctx.skipAgent = true

  const jobsDir = String(args?.jobsDir ?? capabilitiesRoot(ctx.cwd))
  const slugArg = String(args?.slugArg ?? "capability")
  const fenceLabel = String(args?.fenceLabel ?? "kody-job-next-state")
  const shell = String(args?.shell ?? "tick.sh")
  const slug = String(args?.slug ?? ctx.args[slugArg] ?? ctx.args.capability ?? "").trim()

  if (!slug) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runScheduledImplementationTick: args.slug or ctx.args.${slugArg} must be non-empty capability slug`
    return
  }

  const capability = resolveCapabilityFolder(slug, path.resolve(ctx.cwd, jobsDir))
  if (!capability) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runScheduledImplementationTick: capability folder not found or incomplete: ${slug} (searched ${jobsDir} and company store)`
    return
  }

  const shellPath = path.join(profile.dir, shell)
  if (!fs.existsSync(shellPath)) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runScheduledImplementationTick: shell not found: ${shell} (looked in ${profile.dir})`
    return
  }

  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  let loaded: Awaited<ReturnType<typeof backend.load>>
  try {
    loaded = await backend.load(slug)
  } catch (err) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runScheduledImplementationTick: state load failed: ${err instanceof Error ? err.message : String(err)}`
    return
  }

  ctx.data.jobSlug = slug
  ctx.data.capabilitySlug = slug
  ctx.data.implementationSlug = profile.name
  ctx.data.jobState = loaded

  runTickShellAndParse({
    ctx,
    loaded,
    scriptPath: shellPath,
    displayName: `runScheduledImplementationTick: ${shell}`,
    fenceLabel,
    force: Boolean(ctx.args.force),
  })
}
