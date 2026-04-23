/**
 * Postflight (orchestrator-only): write `ctx.data.taskState` back to the
 * issue's state-comment WITHOUT applying any reducer action. Used by the
 * orchestrator profile in place of `saveTaskState`, so that orchestrator
 * runs (which legitimately have no agent action of their own) don't pollute
 * `state.core.lastOutcome` with a synthesized RUN_COMPLETED that would
 * misroute the next transition.
 *
 * Reads:
 *   - ctx.data.taskState — must already reflect the desired flow updates
 *     made by startFlow / dispatch / finishFlow.
 *
 * Writes:
 *   - issue state-comment via writeTaskState.
 */

import type { PostflightScript } from "../executables/types.js"
import { type TaskState, writeTaskState } from "../state.js"

export const persistFlowState: PostflightScript = async (ctx) => {
  const state = ctx.data.taskState as TaskState | undefined
  if (!state) return
  const issueNumber = (ctx.args.issue as number | undefined) ?? state.flow?.issueNumber
  if (!issueNumber) return
  try {
    writeTaskState("issue", issueNumber, state, ctx.cwd)
  } catch (err) {
    process.stderr.write(
      `[kody persistFlowState] failed to write state on issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}
