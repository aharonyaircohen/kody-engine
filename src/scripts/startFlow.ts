/**
 * Postflight (orchestrator-only): seed `state.flow` if not already set, then
 * dispatch the first child executable. Idempotent — if a flow is already in
 * progress for this issue, no-op.
 *
 * Args (from profile entry's `with` object):
 *   - entry: name of the first child executable to invoke (e.g. "plan")
 *   - target: "issue" | "pr" — where to post the @kody comment
 *
 * Reads:
 *   - profile.name       — orchestrator's own executable name, which IS
 *                           the flow name (e.g. "bug", "feature", "spec")
 *   - ctx.args.issue     — orchestrator's --issue input
 *   - ctx.data.taskState — loaded by `loadTaskState` preflight
 *
 * Writes:
 *   - ctx.data.taskState.flow — initialized
 *   - ctx.output.nextDispatch — hands the first child to kody-cli (in-process)
 *
 * Why in-process instead of an `@kody <entry>` comment: when Kody runs as a
 * GitHub App the comment is bot-authored and the follow-up run silently
 * ignores it, stalling the flow before it starts.
 */

import type { PostflightScript, ScriptArgs } from "../executables/types.js"
import { parsePrNumber } from "../issue.js"
import type { TaskState } from "../state.js"

export const startFlow: PostflightScript = async (ctx, profile, _agentResult, args?: ScriptArgs) => {
  const entry = args?.entry as string | undefined
  if (!entry) {
    process.stderr.write("[kody startFlow] missing `with.entry` — skipping\n")
    return
  }
  const target = (args?.target as string | undefined) ?? "issue"

  // Flow name = orchestrator's own executable name. This is what advanceFlow
  // posts back (`@kody <flow-name>`) to retrigger the same sub-orchestrator.
  const flowName = profile.name
  const issueNumber = ctx.args.issue as number | undefined
  if (!issueNumber) {
    process.stderr.write("[kody startFlow] no --issue arg — skipping\n")
    return
  }

  const state = ctx.data.taskState as TaskState | undefined
  if (state?.flow) {
    // Already in flight; nothing to seed.
    return
  }

  if (state) {
    state.flow = {
      name: flowName,
      step: entry,
      issueNumber,
      startedAt: new Date().toISOString(),
      hops: 0,
    }
  }

  // Hand the first child to kody-cli for in-process execution.
  const usePr = target === "pr" && !!state?.core.prUrl
  const targetNumber = usePr ? (parsePrNumber(state!.core.prUrl!) ?? issueNumber) : issueNumber
  ctx.output.nextDispatch = {
    executable: entry,
    cliArgs: usePr ? { pr: targetNumber } : { issue: targetNumber },
  }
}
