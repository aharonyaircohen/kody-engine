/**
 * Preflight: run a scheduled agentAction's colocated shell tick.
 *
 * Clean scheduled agentAction pattern:
 * - agentResponsibility profile declares `agentAction`
 * - scheduler passes the agentResponsibility slug as a CLI arg
 * - agentAction profile runs this generic script
 * - local `tick.sh` emits a `kody-job-next-state` fenced block
 * - existing `writeJobStateFile` persists state
 */
import * as fs from "node:fs"
import * as path from "node:path"

import type { PreflightScript } from "../agent-actions/types.js"
import { resolveAgentResponsibilityFolder } from "../registry.js"
import { resolveBackend } from "./jobState/index.js"
import { runTickShellAndParse } from "./tickShellRunner.js"

export const runScheduledAgentActionTick: PreflightScript = async (ctx, profile, args) => {
  ctx.skipAgent = true

  const jobsDir = String(args?.jobsDir ?? ".kody/agent-responsibilities")
  const slugArg = String(args?.slugArg ?? "agentResponsibility")
  const fenceLabel = String(args?.fenceLabel ?? "kody-job-next-state")
  const shell = String(args?.shell ?? "tick.sh")
  const slug = String(args?.slug ?? ctx.args[slugArg] ?? "").trim()

  if (!slug) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runScheduledAgentActionTick: args.slug or ctx.args.${slugArg} must be non-empty agentResponsibility slug`
    return
  }

  const agentResponsibility = resolveAgentResponsibilityFolder(slug, path.join(ctx.cwd, jobsDir))
  if (!agentResponsibility) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runScheduledAgentActionTick: agentResponsibility folder not found or incomplete: ${slug} (searched ${jobsDir} and company store)`
    return
  }

  const shellPath = path.join(profile.dir, shell)
  if (!fs.existsSync(shellPath)) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runScheduledAgentActionTick: shell not found: ${shell} (looked in ${profile.dir})`
    return
  }

  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  let loaded: Awaited<ReturnType<typeof backend.load>>
  try {
    loaded = await backend.load(slug)
  } catch (err) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runScheduledAgentActionTick: state load failed: ${err instanceof Error ? err.message : String(err)}`
    return
  }

  ctx.data.jobSlug = slug
  ctx.data.agentResponsibilitySlug = slug
  ctx.data.agentActionSlug = profile.name
  ctx.data.jobState = loaded

  runTickShellAndParse({
    ctx,
    loaded,
    scriptPath: shellPath,
    displayName: `runScheduledAgentActionTick: ${shell}`,
    fenceLabel,
    force: Boolean(ctx.args.force),
  })
}
