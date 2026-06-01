/**
 * Preflight: read the task's state comment into ctx.data.taskState.
 * Returns emptyState() if no kody state comment exists yet.
 *
 * Must run AFTER the mode flow (runFlow/fixFlow/...) so that
 * ctx.data.commentTargetType + ctx.data.commentTargetNumber are populated.
 */

import type { PreflightScript } from "../executables/types.js"
import { CorruptStateError, emptyState, readTaskState, type TaskTarget, writeTaskState } from "../state.js"

export const loadTaskState: PreflightScript = async (ctx) => {
  const target = ctx.data.commentTargetType as TaskTarget | undefined
  const number = ctx.data.commentTargetNumber as number | undefined
  if (!target || !number) {
    ctx.data.taskState = emptyState()
    return
  }
  try {
    ctx.data.taskState = readTaskState(target, number, ctx.cwd)
  } catch (err) {
    if (err instanceof CorruptStateError) {
      // A present-but-unparseable state comment. Proceeding on emptyState()
      // would silently redo committed work (re-open PRs, re-run children), so
      // bail loud instead. Heal the comment to a valid empty state first
      // (writeTaskState matches the marker without parsing, so it isn't
      // poisoned by the corruption) — that way the next trigger starts clean
      // rather than crashing forever on the same bad comment.
      process.stderr.write(
        `[kody state] CORRUPT state on ${target} #${number}: ${err.message} — healing to empty and bailing so committed work isn't silently redone.\n`,
      )
      try {
        writeTaskState(target, number, emptyState(), ctx.cwd)
      } catch {
        /* best effort — bail loud regardless */
      }
      ctx.skipAgent = true
      ctx.output.exitCode = 99
      ctx.output.reason = `corrupt task state on ${target} #${number}: ${err.message}`
      return
    }
    throw err
  }
}
