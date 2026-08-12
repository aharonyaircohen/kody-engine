/**
 * Postflight: post the final status comment to whichever target the flow
 * script set (issue or PR). Also computes the terminal exit code from the
 * collected ctx.data state.
 */

import type { Context, PostflightScript } from "../implementations/types.js"
import {
  postIssueComment as ghPostIssueComment,
  postPrReviewComment as ghPostPrReviewComment,
  parsePrNumber,
  truncate,
} from "../issue.js"
import { setKodyLabel } from "../lifecycleLabels.js"
import { setDeliveryNotRequired } from "./deliveryOutcome.js"
import { type PrOutcome, readPrOutcome } from "./prOutcome.js"

const FAILED_LABEL_SPEC = {
  label: "kody:failed",
  color: "e11d21",
  description: "kody: flow failed",
}

const REVIEWING_LABEL_SPEC = {
  label: "kody:reviewing",
  color: "d93f0b",
  description: "kody: PR ready for human review",
}

export const postIssueComment: PostflightScript = async (ctx, profile) => {
  // Preflight early-exit path: whoever set output.exitCode already did the user-facing comment.
  if (ctx.skipAgent && ctx.output.exitCode !== undefined) return

  const targetType = ctx.data.commentTargetType as "issue" | "pr" | undefined
  const targetNumber = Number(ctx.data.commentTargetNumber ?? 0)
  if (!targetType || !targetNumber) return

  const commitResult = ctx.data.commitResult as { committed: boolean } | undefined
  const hasCommits = Boolean(ctx.data.hasCommitsAhead)
  const prResult = readPrOutcome(ctx.data)

  if (!commitResult?.committed && !hasCommits) {
    // Prefer the specific agent failure reason when one exists (e.g.
    // markerMissing diagnostic). Falls back to "no changes to commit" only
    // when the agent has no failure to report — e.g. all edits in forbidden
    // paths.
    const specific = computeFailureReason(ctx)
    if (specific.length === 0) {
      if ((ctx.output.exitCode ?? 0) !== 0) {
        const reason = ctx.output.reason || "delivery failed before producing a commit"
        postWith(targetType, targetNumber, `⚠️ kody FAILED: ${truncate(reason, 1500)}`, ctx.cwd)
        markRunFailed(ctx)
        ctx.output.reason = reason
        return
      }
      const reason = "work already satisfied; no PR needed"
      setDeliveryNotRequired(ctx.data, reason)
      postWith(targetType, targetNumber, `ℹ️ kody made no changes — ${reason}`, ctx.cwd)
      ctx.output.exitCode = 0
      return
    }
    const reason = specific
    // When this primitive is running as a child that the parent explicitly
    // continues from, the parent owns the terminal status. Emit a softer
    // informational comment so the issue thread shows progress, not a dead
    // task, while preserving the child's non-zero exit for routing.
    const continuableParent = continuableParentLabel(ctx)
    if (continuableParent) {
      postWith(
        targetType,
        targetNumber,
        `ℹ️ kody ${profile.name}: ${truncate(reason, 1200)} — ${continuableParent} will route to the next stage`,
        ctx.cwd,
      )
      ctx.output.exitCode = 3
      ctx.output.reason = reason
      return
    }
    postWith(targetType, targetNumber, `⚠️ kody FAILED: ${truncate(reason, 1500)}`, ctx.cwd)
    markRunFailed(ctx)
    ctx.output.exitCode = 3
    ctx.output.reason = reason
    return
  }

  if (ctx.output.exitCode === 4 && ctx.data.prCrashReason) {
    postWith(targetType, targetNumber, `⚠️ kody FAILED: ${truncate(ctx.data.prCrashReason as string, 1500)}`, ctx.cwd)
    markRunFailed(ctx)
    ctx.output.reason = ctx.data.prCrashReason as string
    return
  }

  // Commit landed locally but the push failed: commitAndPush set exit 4 +
  // `commitCrash`, and the executor then BLOCKS the mutating `ensurePr`
  // postflight (shouldBlockMutatingPostflight), so `prCrashReason` is never
  // set and the guard above misses it. Without this branch we'd fall through
  // and recompute a 0 exit below — reporting success while the work never
  // reached the remote and the ephemeral runner is torn down. Mirror the
  // prCrashReason terminal path.
  if (ctx.output.exitCode === 4 && ctx.data.commitCrash) {
    postWith(targetType, targetNumber, `⚠️ kody FAILED: ${truncate(ctx.data.commitCrash as string, 1500)}`, ctx.cwd)
    markRunFailed(ctx)
    ctx.output.reason = ctx.data.commitCrash as string
    return
  }

  const failureReason = computeFailureReason(ctx)
  const isFailure = failureReason.length > 0
  const branch = ctx.data.branch as string | undefined

  // Render the user-facing message by exhaustively switching on the typed
  // PR outcome. There is NO default branch that templates `${prUrl}` — every
  // case either has a guaranteed url field (created/updated) or carries an
  // explicit `reason` (skipped/crashed). This eliminates the "PR opened:
  // undefined" class of bug at the type level.
  const msg = renderMessage({
    prResult,
    isFailure,
    failureReason,
    justPushedToExistingPr: prResult?.kind === "updated" && commitResult?.committed === true,
    branch,
    branchPushed: commitResult?.committed === true,
    githubOwner: ctx.config.github?.owner,
    githubRepo: ctx.config.github?.repo,
  })
  postWith(targetType, targetNumber, msg, ctx.cwd)

  const prIsDraft =
    (prResult?.kind === "created" || prResult?.kind === "updated") && prResult.draft === true
  if (!isFailure && !prIsDraft) {
    markPrReadyForReview(ctx, prResult)
  }

  let exitCode = 0
  const agentDone = Boolean(ctx.data.agentDone)
  const verifyOk = ctx.data.verifyOk !== false
  const misses = (ctx.data.coverageMisses as unknown[] | undefined) ?? []
  if (!agentDone || misses.length > 0) exitCode = 1
  else if (!verifyOk) exitCode = 2
  // Never LOWER a non-zero exit a prior postflight already recorded (e.g. a
  // commit/push crash that the guards above didn't terminate on). Keeping the
  // terminal code monotonic stops a green "success" from masking lost work.
  exitCode = Math.max(ctx.output.exitCode ?? 0, exitCode)
  if (exitCode !== 0) markRunFailed(ctx)
  ctx.output.exitCode = exitCode
  ctx.output.reason = failureReason || undefined
}

/**
 * Best-effort lifecycle cleanup: flip `kody:running` → `kody:failed` on the
 * issue (and PR, when known) whenever this script is the terminus on a
 * failure path. The outer orchestrator's `finishFlow` handles labels on the
 * success path; without this, a failed primitive run leaves the issue
 * stamped `kody:running`, which dashboards interpret as "still building".
 */
function markRunFailed(ctx: Context): void {
  const issueNumber = ctx.args.issue as number | undefined
  if (typeof issueNumber === "number" && Number.isFinite(issueNumber)) {
    setKodyLabel(issueNumber, FAILED_LABEL_SPEC, ctx.cwd)
  }
  const targetType = ctx.data.commentTargetType as "issue" | "pr" | undefined
  const targetNumber = Number(ctx.data.commentTargetNumber ?? 0)
  if (targetType === "pr" && targetNumber > 0 && targetNumber !== issueNumber) {
    setKodyLabel(targetNumber, FAILED_LABEL_SPEC, ctx.cwd)
  }
}

function markPrReadyForReview(ctx: Context, prResult: PrOutcome | null): void {
  if (prResult?.kind !== "created" && prResult?.kind !== "updated") return

  const targets = new Set<number>()
  const issueNumber = ctx.args.issue as number | undefined
  if (typeof issueNumber === "number" && Number.isFinite(issueNumber)) {
    targets.add(issueNumber)
  }

  const targetNumber = Number(ctx.data.commentTargetNumber ?? 0)
  if (targetNumber > 0) targets.add(targetNumber)

  const prNumber = prResult.number ?? parsePrNumber(prResult.url)
  if (prNumber) targets.add(prNumber)

  for (const target of targets) {
    setKodyLabel(target, REVIEWING_LABEL_SPEC, ctx.cwd)
  }
}

/**
 * Build the trailing "— PR: …" / "— draft PR: …" / "— branch: …" suffix for
 * the failure comment. When ensurePr was skipped or crashed we still want
 * the user to have a one-click path to inspect the agent's edits, so fall
 * back to a branch URL whenever commitAndPush actually pushed.
 *
 * Exported for unit testing.
 */
export function computeFailureSuffix(input: {
  prResult: PrOutcome | null
  branch: string | undefined
  branchPushed: boolean
  githubOwner: string | undefined
  githubRepo: string | undefined
}): string {
  if (input.prResult?.kind === "created") return ` — draft PR: ${input.prResult.url}`
  if (input.prResult?.kind === "updated") return ` — PR: ${input.prResult.url}`
  // skipped / crashed / null → fall back to branch URL when available.
  if (!input.branchPushed || !input.branch || !input.githubOwner || !input.githubRepo) return ""
  return ` — branch: https://github.com/${input.githubOwner}/${input.githubRepo}/tree/${input.branch}`
}

/**
 * Render the user-facing comment body. Exhaustive switch on the typed
 * PR outcome guarantees every code path either uses a real URL (created /
 * updated) or carries an explicit reason (skipped / crashed / null).
 * No template ever interpolates an undefined value.
 *
 * Exported for unit testing.
 */
export function renderMessage(input: {
  prResult: PrOutcome | null
  isFailure: boolean
  failureReason: string
  justPushedToExistingPr: boolean
  branch: string | undefined
  branchPushed: boolean
  githubOwner: string | undefined
  githubRepo: string | undefined
}): string {
  const suffix = computeFailureSuffix(input)
  if (input.isFailure) {
    return `⚠️ kody FAILED: ${truncate(input.failureReason, 1500)}${suffix}`
  }
  // Success path. Each branch carries its own URL or explicit explanation —
  // no template can interpolate `undefined` because PrCreated/PrUpdated
  // require a url field at the type level.
  switch (input.prResult?.kind) {
    case "created":
      return `✅ kody PR opened: ${input.prResult.url}`
    case "updated":
      return input.justPushedToExistingPr
        ? `✅ kody pushed to ${input.prResult.url}`
        : `ℹ️ kody made no changes — PR: ${input.prResult.url}`
    case "skipped":
      return `⚠️ kody finished but did not open a PR — ${input.prResult.reason}${suffix}`
    case "crashed":
      return `⚠️ kody PR step crashed: ${truncate(input.prResult.reason, 1500)}${suffix}`
    case undefined:
      // null prResult = ensurePr never executed (e.g., executor short-
      // circuited before postflights). Boundary assertion: never claim
      // success without evidence.
      return `⚠️ kody finished but PR step did not run${suffix}`
  }
}

function computeFailureReason(ctx: { data: Record<string, unknown> }): string {
  const misses = (ctx.data.coverageMisses as { expectedTest: string }[] | undefined) ?? []
  if (misses.length > 0) return `missing tests: ${misses.map((m) => m.expectedTest).join(", ")}`

  const agentDone = Boolean(ctx.data.agentDone)
  if (!agentDone) {
    return (
      (ctx.data.agentFailureReason as string) ||
      (ctx.data.agentError as string) ||
      actionFailureReason(ctx.data.action) ||
      "agent did not emit DONE"
    )
  }
  if (ctx.data.verifyOk === false) return (ctx.data.verifyReason as string) || "verify failed"
  return ""
}

function actionFailureReason(action: unknown): string {
  if (!action || typeof action !== "object" || Array.isArray(action)) return ""
  const payload = (action as { payload?: unknown }).payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return ""
  const reason = (payload as { reason?: unknown }).reason
  return typeof reason === "string" ? reason : ""
}

function actionType(action: unknown): string {
  if (!action || typeof action !== "object" || Array.isArray(action)) return ""
  const type = (action as { type?: unknown }).type
  return typeof type === "string" ? type : ""
}

function continuableParentLabel(ctx: Context): string {
  const workflowCapability =
    typeof ctx.data.workflowCapability === "string" && ctx.data.workflowCapability.trim()
      ? ctx.data.workflowCapability.trim()
      : ""
  const workflowContinueOn = Array.isArray(ctx.data.workflowContinueOn)
    ? ctx.data.workflowContinueOn.filter((entry): entry is string => typeof entry === "string")
    : []
  const currentActionType = actionType(ctx.data.action)
  if (workflowCapability && currentActionType && workflowContinueOn.includes(currentActionType)) {
    return `${workflowCapability} workflow`
  }

  const containerParent = process.env.KODY_CONTAINER_PARENT
  return containerParent ? `${containerParent} container` : ""
}

function postWith(type: "issue" | "pr", n: number, body: string, cwd?: string): void {
  try {
    if (type === "issue") ghPostIssueComment(n, body, cwd)
    else ghPostPrReviewComment(n, body, cwd)
  } catch {
    /* best effort */
  }
}
