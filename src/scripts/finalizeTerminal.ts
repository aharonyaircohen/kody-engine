/**
 * Postflight (single-session implementations): settle the run label + phase/status
 * after delivery is known.
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
 *   - PR success := agent exited 0 AND a PR was created → kody:reviewing,
 *                   phase "reviewing", status "succeeded".
 *   - no-delivery success := agent exited 0 AND no PR was needed → kody:done,
 *                            phase "shipped", status "succeeded".
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
  description: "kody: work complete",
}
const REVIEWING: KodyLabelSpec = {
  label: "kody:reviewing",
  color: "d93f0b",
  description: "kody: PR ready for human review",
}
const FAILED: KodyLabelSpec = {
  label: "kody:failed",
  color: "e11d21",
  description: "kody: flow failed",
}

export const finalizeTerminal: PostflightScript = async (ctx) => {
  // If this run is a child of an in-progress flow, the orchestrator owns the
  // final label (it re-triggers via advanceFlow and stamps the terminal state
  // in finishFlow). Standalone runs (no flow) fall through and settle
  // themselves so the target is not left with a mid-run label.
  const flow = (ctx.data.taskState as TaskState | undefined)?.flow
  if (flow?.issueNumber) return

  const target = (ctx.data.commentTargetType as TaskTarget | undefined) ?? "issue"
  const issueNumber = ctx.args.issue as number | undefined
  const targetNumber = (ctx.data.commentTargetNumber as number | undefined) ?? issueNumber
  if (!targetNumber) return

  const cachedState = ctx.data.taskState as TaskState | undefined
  let state = cachedState
  const prUrl = cachedState?.core.prUrl ?? ctx.output.prUrl ?? (ctx.data.prResult as { url?: string } | undefined)?.url

  const hasPr = !!prUrl
  const noDeliveryNeeded = isDeliveryNotRequired(ctx.data)
  const succeeded = ctx.output.exitCode === 0 && (hasPr || noDeliveryNeeded)
  const spec = succeeded ? (hasPr ? REVIEWING : DONE) : FAILED
  const phase: Phase = succeeded ? (hasPr ? "reviewing" : "shipped") : "failed"
  const status: Status = succeeded ? "succeeded" : "failed"

  // Apply the resolved label to the issue AND the PR (when one exists) so
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
    state.core.phase === phase && state.core.status === status && state.core.currentImplementation === null
  if (alreadyTerminal) return

  const next: TaskState = {
    ...state,
    core: {
      ...state.core,
      phase,
      status,
      currentImplementation: null,
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
}
