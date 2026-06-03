/**
 * Postflight (added to every child executable's tail): if a flow is in
 * progress, re-trigger the flow orchestrator IN-PROCESS via
 * `ctx.output.nextDispatch` (kody-cli runs it). `state.flow.name` is the
 * executable name of the orchestrator itself (e.g. "bug", "feature", "spec",
 * "chore") per the semantic-naming convention.
 *
 * Why in-process instead of an `@kody <flow.name>` comment: when Kody runs as
 * a GitHub App the comment is bot-authored and the follow-up run silently
 * ignores it, stalling the flow mid-way.
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
 *
 * Loop guard: each re-trigger increments `state.flow.hops`. Past
 * FLOW_HOP_CAP we stop, clear the flow, and post a notice instead of
 * re-triggering — so a flow that never reaches a terminal phase cannot
 * self-trigger forever. This is the hard ceiling behind dispatch.ts honoring
 * Kody's own `@kody <command>` self-dispatch comments.
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript } from "../executables/types.js"
import { type Action, readTaskState, reduce, type TaskState, writeTaskState } from "../state.js"

const API_TIMEOUT_MS = 30_000
const FLOW_HOP_CAP = 25

function ghComment(issueNumber: number, body: string, cwd: string, label: string): void {
  try {
    execFileSync("gh", ["issue", "comment", String(issueNumber), "--body", body], {
      timeout: API_TIMEOUT_MS,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    process.stderr.write(
      `[kody advanceFlow] ${label} on issue #${issueNumber} failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}

export const advanceFlow: PostflightScript = async (ctx, profile) => {
  const state = ctx.data.taskState as TaskState | undefined
  const flow = state?.flow
  if (!flow?.issueNumber) return

  // The authoritative flow state lives on the issue (the orchestrator's home).
  // Read it to track the hop count across runs; fall back to the current run's
  // state if the issue read fails.
  // `flow` is non-null here, so `state` (its container) is too.
  const curState = state as TaskState
  let issueState: TaskState
  try {
    issueState = readTaskState("issue", flow.issueNumber, ctx.cwd)
  } catch {
    issueState = curState
  }

  // If this child's saveTaskState wrote to the PR (commentTargetType="pr"),
  // mirror its action into the issue's state too — that's where the
  // orchestrator looks for `lastOutcome`.
  const targetType = ctx.data.commentTargetType as string | undefined
  const action = ctx.data.action as Action | undefined
  let nextIssueState: TaskState = issueState
  if (targetType === "pr" && action) {
    nextIssueState = reduce(issueState, profile.name, action, profile.phase, profile.staff)
    // Preserve PR URL on the issue's state too.
    if (state?.core.prUrl && !nextIssueState.core.prUrl) nextIssueState.core.prUrl = state.core.prUrl
  }

  const prevHops = issueState.flow?.hops ?? flow.hops ?? 0
  const hops = prevHops + 1

  if (hops > FLOW_HOP_CAP) {
    // Loop guard tripped: clear the flow so nothing self-triggers again, and
    // tell the issue why we stopped.
    nextIssueState.flow = undefined
    try {
      writeTaskState("issue", flow.issueNumber, nextIssueState, ctx.cwd)
    } catch (err) {
      process.stderr.write(
        `[kody advanceFlow] failed to clear looping flow on issue #${flow.issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
    ghComment(
      flow.issueNumber,
      `⚠️ kody: flow \`${flow.name}\` stopped after ${FLOW_HOP_CAP} steps without completing (loop guard). Re-trigger manually if this was intended.`,
      ctx.cwd,
      "loop-guard notice",
    )
    process.stderr.write(
      `[kody advanceFlow] flow '${flow.name}' on issue #${flow.issueNumber} hit hop cap ${FLOW_HOP_CAP}; stopping\n`,
    )
    return
  }

  // Persist the incremented hop count on the issue's flow state before
  // re-triggering, so the next run sees the higher count.
  nextIssueState.flow = { ...flow, hops }
  try {
    writeTaskState("issue", flow.issueNumber, nextIssueState, ctx.cwd)
  } catch (err) {
    process.stderr.write(
      `[kody advanceFlow] failed to persist hop count on issue #${flow.issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }

  // Re-run the same sub-orchestrator that started this flow (e.g. "bug",
  // "feature") in-process, so it advances to the next stage.
  ctx.output.nextDispatch = { executable: flow.name, cliArgs: { issue: flow.issueNumber } }
}
