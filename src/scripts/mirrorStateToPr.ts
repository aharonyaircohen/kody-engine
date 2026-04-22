/**
 * Postflight: if this run produced (or already had) a PR, mirror the issue's
 * current task-state comment onto the PR so subsequent PR-targeted
 * executables (review, fix) and the orchestrator can read the same flow
 * context from either place.
 *
 * Idempotent: if the PR already has a kody2 state-comment, the existing
 * writeTaskState call updates it in place. No-op when no PR exists.
 *
 * Must run AFTER saveTaskState (which writes the issue-side state) and
 * AFTER ensurePr (which materializes prUrl).
 */

import type { PostflightScript } from "../executables/types.js"
import { readTaskState, type TaskState, writeTaskState } from "../state.js"

export const mirrorStateToPr: PostflightScript = async (ctx) => {
  const issueNumber = ctx.data.commentTargetNumber as number | undefined
  const issueTarget = ctx.data.commentTargetType as string | undefined
  if (!issueNumber || issueTarget !== "issue") return

  const prUrl = ctx.output.prUrl ?? (ctx.data.prResult as { url?: string } | undefined)?.url
  if (!prUrl) return

  const prNumber = parsePrNumber(prUrl)
  if (!prNumber) return

  let state: TaskState
  try {
    state = readTaskState("issue", issueNumber, ctx.cwd)
  } catch {
    return
  }
  if (prUrl && !state.core.prUrl) state.core.prUrl = prUrl

  try {
    writeTaskState("pr", prNumber, state, ctx.cwd)
  } catch (err) {
    process.stderr.write(
      `[kody2 mirrorStateToPr] failed to mirror state to PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}

export function parsePrNumber(prUrl: string): number | null {
  const m = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : null
}
