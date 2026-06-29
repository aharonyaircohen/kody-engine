/**
 * Postflight (single-session executables): stamp the TERMINAL label +
 * phase/status after the PR exists.
 *
 * This is the orchestration-free replacement for what container profiles
 * did via `finishFlow`. A single-session executable (feature, bug, …) has
 * no orchestrator to re-trigger and no `state.flow` to clear — it just
 * needs the issue/PR to end in an honest terminal state so the dashboard
 * and goal-phase derivation don't show it stuck in "building" forever.
 *
 * Runs LAST in the pr-branch tail (after saveTaskState), gated by
 * `lifecycleConfig.finalize: true`. It uses the just-written cached state
 * when available (saveTaskState is authoritative) and decides:
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

import type { PostflightScript } from "../executables/types.js"
import { parsePrNumber } from "../issue.js"
import { type KodyLabelSpec, setKodyLabel } from "../lifecycleLabels.js"
import { type Phase, readTaskState, type Status, type TaskState, type TaskTarget, writeTaskState } from "../state.js"
import { isDeliveryNotRequired } from "./deliveryOutcome.js"

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

  const cachedState = ctx.data.taskState as TaskState | undefined
  let state = cachedState
  let prUrl = cachedState?.core.prUrl ?? ctx.output.prUrl ?? (ctx.data.prResult as { url?: string } | undefined)?.url

  // Fall back to the on-disk state file when neither the cached state nor the
  // in-flight output carry prUrl. saveTaskState writes prUrl to the target's
  // state file before finalizeTerminal runs, so the file is the next-best
  // source — needed when ctx.data.taskState hasn't been refreshed (e.g. a
  // retry against a stale in-memory snapshot, or a child run that didn't
  // touch ctx.output.prUrl). Without this fallback, a successful PR run with
  // no cached prUrl would be mis-classified as failed and the mirror below
  // would leave the issue frozen at the previous failed status. Skipped when
  // exitCode !== 0 because prUrl is irrelevant to delivered when the run
  // already exited non-zero.
  if (!prUrl && ctx.output.exitCode === 0 && targetNumber) {
    try {
      const fileState = readTaskState(target, targetNumber, ctx.cwd, ctx.config)
      if (fileState?.core.prUrl) prUrl = fileState.core.prUrl
    } catch {
      // best-effort — keep going with what we have
    }
  }

  const delivered = ctx.output.exitCode === 0 && (!!prUrl || isDeliveryNotRequired(ctx.data))
  const spec = delivered ? DONE : FAILED
  const phase: Phase = delivered ? "shipped" : "failed"
  const status: Status = delivered ? "succeeded" : "failed"

  // Apply terminal label to the issue AND the PR (when one exists) so
  // neither is left stamped with the mid-run `kody:running`.
  if (issueNumber) setKodyLabel(issueNumber, spec, ctx.cwd)
  const prNumber = prUrl ? parsePrNumber(prUrl) : null
  if (prNumber && prNumber !== issueNumber) setKodyLabel(prNumber, spec, ctx.cwd)

  if (!state) {
    try {
      state = readTaskState(target, targetNumber, ctx.cwd, ctx.config)
    } catch {
      state = undefined
    }
  }

  if (!state) return

  const alreadyTerminal =
    state.core.phase === phase && state.core.status === status && state.core.currentExecutable === null
  if (alreadyTerminal) return

  const next: TaskState = {
    ...state,
    core: {
      ...state.core,
      phase,
      status,
      currentExecutable: null,
    },
  }
  ctx.data.taskState = next

  // Best-effort: a failed write is logged, not thrown — the user-visible
  // label is already in place.
  try {
    writeTaskState(target, targetNumber, next, ctx.cwd, ctx.config)
  } catch (err) {
    process.stderr.write(
      `[kody finalizeTerminal] failed to write terminal state on ${target} #${targetNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }

  // Mirror the terminal state to the issue when the run targeted a PR
  // (e.g. `@kody fix` retry on a PR) and the issue is a separate number.
  // Without this, a successful retry leaves the issue's state comment
  // frozen at the previous `status: "failed"`, so the dashboard keeps
  // the card in the Failed column even though the work succeeded. The
  // label mirror (issue + PR both get kody:done) already does this; the
  // state comment write was asymmetric and is being aligned here.
  // Self-skip: an issue-only run with no PR reports targetNumber ===
  // issueNumber (the same number), and the write above already covered
  // it — the mirror would just re-PATCH the same comment.
  if (target === "pr" && issueNumber && issueNumber !== targetNumber) {
    try {
      const issueState = readTaskState("issue", issueNumber, ctx.cwd, ctx.config)
      issueState.core.phase = phase
      issueState.core.status = status
      issueState.core.currentExecutable = null
      writeTaskState("issue", issueNumber, issueState, ctx.cwd, ctx.config)
    } catch (err) {
      process.stderr.write(
        `[kody finalizeTerminal] failed to mirror terminal state to issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }
}
