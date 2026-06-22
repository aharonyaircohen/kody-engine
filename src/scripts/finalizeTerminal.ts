/**
 * Postflight (single-session agentActions): stamp the TERMINAL label +
 * phase/status after the PR exists.
 *
 * This is the orchestration-free replacement for what container profiles
 * did via `finishFlow`. A single-session agentAction (feature, bug, …) has
 * no orchestrator to re-trigger and no `state.flow` to clear — it just
 * needs the issue/PR to end in an honest terminal state so the dashboard
 * and goal-phase derivation don't show it stuck in "building" forever.
 *
 * Runs LAST in the pr-branch tail (after saveTaskState), gated by
 * `lifecycleConfig.finalize: true`. It re-reads the just-written state
 * comment (saveTaskState is authoritative) and decides:
 *
 *   - success  := agent exited 0 AND a PR was created  → kody:done,
 *                 phase "shipped", status "succeeded".
 *   - failure  := anything else (including "exit 0 but no PR" — that is a
 *                 delivery failure, not success) → kody:failed,
 *                 phase "failed", status "failed".
 *
 * The "exit 0 but no PR" branch is deliberate: masking a no-diff run as
 * success/in-progress is the exact failure this collapse is meant to
 * remove. Better a loud kody:failed than a silently stuck card.
 */

import type { PostflightScript } from "../agent-actions/types.js"
import { parsePrNumber } from "../issue.js"
import { type KodyLabelSpec, setKodyLabel } from "../lifecycleLabels.js"
import { type Phase, readTaskState, type Status, type TaskState, type TaskTarget, writeTaskState } from "../state.js"

const DONE: KodyLabelSpec = {
  label: "kody:done",
  color: "0e8a16",
  description: "kody: PR ready for human review/merge",
}
const FAILED: KodyLabelSpec = {
  label: "kody:failed",
  color: "e11d21",
  description: "kody: flow failed",
}

export const finalizeTerminal: PostflightScript = async (ctx) => {
  // If this run is a child of an in-progress flow, the orchestrator owns the
  // terminal label (it re-triggers via advanceFlow and stamps kody:done in
  // finishFlow). Self-finalizing here would mark the PR done before the
  // flow's later stages run. Standalone runs (no flow) fall through and
  // finalize themselves — this is what restores kody:done after a lone
  // `@kody fix` / `run` / `fix-ci` instead of leaving the target unlabeled.
  const flow = (ctx.data.taskState as TaskState | undefined)?.flow
  if (flow?.issueNumber) return

  const target = (ctx.data.commentTargetType as TaskTarget | undefined) ?? "issue"
  const issueNumber = ctx.args.issue as number | undefined
  const targetNumber = (ctx.data.commentTargetNumber as number | undefined) ?? issueNumber
  if (!targetNumber) return

  // saveTaskState already wrote the authoritative state; re-read it rather
  // than trust the in-memory ctx.data.taskState (which saveTaskState does
  // not reassign after reducing).
  let prUrl: string | undefined
  try {
    prUrl = readTaskState(target, targetNumber, ctx.cwd).core.prUrl
  } catch {
    prUrl = undefined
  }

  const delivered = ctx.output.exitCode === 0 && !!prUrl
  const spec = delivered ? DONE : FAILED
  const phase: Phase = delivered ? "shipped" : "failed"
  const status: Status = delivered ? "succeeded" : "failed"

  // Apply terminal label to the issue AND the PR (when one exists) so
  // neither is left stamped with the mid-run `kody:running`.
  if (issueNumber) setKodyLabel(issueNumber, spec, ctx.cwd)
  const prNumber = prUrl ? parsePrNumber(prUrl) : null
  if (prNumber && prNumber !== issueNumber) setKodyLabel(prNumber, spec, ctx.cwd)

  // Flip the state comment to the terminal phase/status so the dashboard
  // reads a real terminus instead of the last mid-run "implementing".
  // Best-effort: a failed write is logged, not thrown — the user-visible
  // label is already in place.
  try {
    const state = readTaskState(target, targetNumber, ctx.cwd)
    state.core.phase = phase
    state.core.status = status
    state.core.currentAgentAction = null
    writeTaskState(target, targetNumber, state, ctx.cwd)
  } catch (err) {
    process.stderr.write(
      `[kody finalizeTerminal] failed to write terminal state on ${target} #${targetNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}
