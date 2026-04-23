/**
 * Postflight (added to every child executable's tail): if a flow is in
 * progress, re-trigger the flow orchestrator by posting `@kody <flow.name>`
 * on the originating issue. `state.flow.name` is the executable name of the
 * orchestrator itself (e.g. "bug", "feature", "spec", "chore") per the
 * semantic-naming convention.
 *
 * No-op when:
 *   - state.flow is absent (child was triggered standalone), or
 *   - state.flow.issueNumber is not set.
 *
 * Children that emit their action into a PR-side state (review, fix) ALSO
 * need their action mirrored into the issue's state so the orchestrator —
 * which reads from the issue — sees a fresh `lastOutcome`. That mirror is
 * done here too: we re-read the issue state, apply the reducer with the
 * action this child just emitted, and write back.
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript } from "../executables/types.js"
import { type Action, readTaskState, reduce, type TaskState, writeTaskState } from "../state.js"

const API_TIMEOUT_MS = 30_000

export const advanceFlow: PostflightScript = async (ctx, profile) => {
  const state = ctx.data.taskState as TaskState | undefined
  const flow = state?.flow
  if (!flow?.issueNumber) return

  // If this child's saveTaskState wrote to the PR (commentTargetType="pr"),
  // mirror its action into the issue's state too — that's where the
  // orchestrator looks for `lastOutcome`.
  const targetType = ctx.data.commentTargetType as string | undefined
  const action = ctx.data.action as Action | undefined
  if (targetType === "pr" && action) {
    try {
      const issueState = readTaskState("issue", flow.issueNumber, ctx.cwd)
      issueState.flow = flow
      const next = reduce(issueState, profile.name, action, profile.phase)
      // Preserve PR URL on the issue's state too.
      if (state?.core.prUrl && !next.core.prUrl) next.core.prUrl = state.core.prUrl
      next.flow = flow
      writeTaskState("issue", flow.issueNumber, next, ctx.cwd)
    } catch (err) {
      process.stderr.write(
        `[kody advanceFlow] failed to mirror action to issue #${flow.issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  // Post `@kody <flow-name>` so dispatch.ts routes the retrigger to the
  // same sub-orchestrator that started this flow (e.g. "bug", "feature").
  const body = `@kody ${flow.name}`
  try {
    execFileSync("gh", ["issue", "comment", String(flow.issueNumber), "--body", body], {
      timeout: API_TIMEOUT_MS,
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    process.stderr.write(
      `[kody advanceFlow] failed to re-trigger orchestrator on issue #${flow.issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}
