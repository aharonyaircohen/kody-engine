/**
 * Postflight (classify-only, runs LAST): post a single combined comment
 * that dispatches the chosen sub-orchestrator AND carries the audit line
 * AND the rendered task-state block (with `kody:state:v1` markers).
 *
 * Why a single combined comment:
 *   GitHub Actions concurrency keeps only the newest pending event in the
 *   `kody-<issue>` group; older pending ones get cancelled. Earlier we
 *   posted three comments (audit, state, dispatch). Webhook delivery
 *   order is not guaranteed to match comment-creation order, so the
 *   dispatch run sometimes lost the race to a bookkeeping run that
 *   exited "no action for event issue_comment" — pipeline stalled.
 *
 *   Posting exactly ONE comment removes the race entirely: classify
 *   emits a single `issue_comment.created` event after the user's
 *   `@kody`, and that comment IS the dispatch.
 *
 * State continuity:
 *   The combined body includes the rendered state block with the
 *   `kody:state:v1` BEGIN/END markers. The next sub-orchestrator
 *   (bug/feature/spec/chore) reads it via `findStateComment` in its
 *   preflight, applies its own action via `saveTaskState`, and PATCHes
 *   the same comment — replacing the body with pure rendered state.
 *   PATCH doesn't fire `issue_comment.created`, so no follow-up race.
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript } from "../executables/types.js"
import { type Action, emptyState, reduce, renderStateComment, type TaskState } from "../state.js"

const API_TIMEOUT_MS = 30_000
const VALID_CLASSES = new Set(["feature", "bug", "spec", "chore"])

export const dispatchClassified: PostflightScript = async (ctx) => {
  const issueNumber = ctx.args.issue as number | undefined
  if (!issueNumber) return

  const classification = ctx.data.classification as string | undefined
  if (!classification || !VALID_CLASSES.has(classification)) return

  const action = ctx.data.action as Action | undefined
  if (!action) return

  // Forward `--base <branch>` from the originating dispatch comment so
  // the chosen sub-orchestrator (chore / feature / etc.) sees it and
  // can pass it through to its `run` child. Without this, goal-tick's
  // stacked-PR dispatch (`@kody --base <leafBranch>`) loses the base
  // here because classify rewrites the issue comment to `@kody chore`.
  const baseArg = typeof ctx.args.base === "string" && ctx.args.base.length > 0 ? ` --base ${ctx.args.base}` : ""
  const dispatchLine = `@kody ${classification}${baseArg}`
  const auditLine =
    (ctx.data.classificationAudit as string | undefined) ?? `🔎 kody classified as \`${classification}\``

  // Apply classify's action to in-memory state and render the state
  // block that will live inside the combined comment. Downstream
  // executables find this block via the `kody:state:v1` markers and
  // PATCH the comment in place (no new `issue_comment.created` event).
  const state = (ctx.data.taskState as TaskState | undefined) ?? emptyState()
  const nextState = reduce(state, "classify", action, undefined)
  const stateBody = renderStateComment(nextState)
  ctx.data.taskState = nextState
  ctx.data.taskStateRendered = stateBody

  const body = `${dispatchLine}\n\n${auditLine}\n\n${stateBody}`

  // Direct execFileSync so the comment reaches GHA's issue_comment.created
  // filter; postIssueComment would sanitize the @kody mention out.
  try {
    execFileSync("gh", ["issue", "comment", String(issueNumber), "--body", body], {
      cwd: ctx.cwd,
      timeout: API_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    process.stderr.write(
      `[kody dispatchClassified] failed to dispatch ${dispatchLine}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    ctx.data.action = failedAction("dispatch post failed")
    ctx.output.exitCode = 1
    ctx.output.reason = "classify: dispatch failed"
  }
}

function failedAction(reason: string): Action {
  return { type: "CLASSIFY_FAILED", payload: { reason }, timestamp: new Date().toISOString() }
}
