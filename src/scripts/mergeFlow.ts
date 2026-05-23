/**
 * Preflight for the `merge` primitive. Self-gating, no agent: it inspects the
 * PR's live mergeability and either squash-merges it or refuses with a reason.
 *
 * The gate is GitHub's own `mergeStateStatus` — we merge ONLY when it reports
 * `CLEAN` (mergeable + every required check and review satisfied). Every other
 * state is a refusal, not a force: a draft, a conflict, a behind-base branch,
 * or pending/failing required checks all leave the PR untouched and post a
 * comment explaining why. This is what "self-gating" means — the primitive
 * never overrides a branch-protection rule, so it is safe for the CTO duty to
 * dispatch unattended once the `merge` verb has graduated.
 *
 * Reads   ctx.args.pr
 * Effects merges the PR (or not) + posts one PR comment; sets ctx.skipAgent.
 */

import type { PreflightScript } from "../executables/types.js"
import { gh } from "../issue.js"
import { commentOnIssue, mergePrSquash } from "../goal/operations.js"

interface PrMergeView {
  state: string
  isDraft: boolean
  mergeable: string
  mergeStateStatus: string
  title: string
  url: string
}

function readPr(prNumber: number, cwd: string): PrMergeView {
  const out = gh(
    [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "state,isDraft,mergeable,mergeStateStatus,title,url",
    ],
    { cwd },
  )
  const p = JSON.parse(out) as Partial<PrMergeView>
  return {
    state: p.state ?? "UNKNOWN",
    isDraft: p.isDraft ?? false,
    mergeable: p.mergeable ?? "UNKNOWN",
    mergeStateStatus: p.mergeStateStatus ?? "UNKNOWN",
    title: p.title ?? "",
    url: p.url ?? "",
  }
}

/**
 * Decide whether `pr` may merge. Returns `{ ok: true }` to merge, or
 * `{ ok: false, action, reason }` to refuse. Pure over the view so it is
 * unit-testable without GitHub.
 */
export function evaluateMergeGate(pr: PrMergeView):
  | { ok: true }
  | { ok: false; action: "MERGE_SKIPPED" | "MERGE_BLOCKED"; reason: string } {
  if (pr.state !== "OPEN") {
    return {
      ok: false,
      action: "MERGE_SKIPPED",
      reason: `PR is ${pr.state.toLowerCase()}, not open — nothing to merge.`,
    }
  }
  if (pr.isDraft) {
    return { ok: false, action: "MERGE_BLOCKED", reason: "PR is still a draft." }
  }
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    return {
      ok: false,
      action: "MERGE_BLOCKED",
      reason: "PR has conflicts with its base branch — resolve them first.",
    }
  }
  if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN") {
    return {
      ok: false,
      action: "MERGE_BLOCKED",
      reason: "GitHub is still computing mergeability — will retry next tick.",
    }
  }
  if (pr.mergeStateStatus === "BEHIND") {
    return {
      ok: false,
      action: "MERGE_BLOCKED",
      reason: "PR branch is behind its base — update it before merging.",
    }
  }
  if (pr.mergeStateStatus !== "CLEAN") {
    // BLOCKED (required checks/reviews unmet), UNSTABLE (a check is failing),
    // HAS_HOOKS, etc. — all mean "not green", so we refuse.
    return {
      ok: false,
      action: "MERGE_BLOCKED",
      reason: `PR is not green (status: ${pr.mergeStateStatus}) — required checks or reviews are not satisfied.`,
    }
  }
  return { ok: true }
}

export const mergeFlow: PreflightScript = async (ctx) => {
  ctx.skipAgent = true

  const prNumber = Number(ctx.args.pr)
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    process.stderr.write(`[merge] invalid --pr value: ${String(ctx.args.pr)}\n`)
    ctx.data.mergeAction = "MERGE_BLOCKED"
    return
  }

  let pr: PrMergeView
  try {
    pr = readPr(prNumber, ctx.cwd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[merge] could not read PR #${prNumber}: ${msg}\n`)
    ctx.data.mergeAction = "MERGE_BLOCKED"
    return
  }

  const verdict = evaluateMergeGate(pr)
  if (!verdict.ok) {
    process.stdout.write(`[merge] PR #${prNumber} not merged — ${verdict.reason}\n`)
    ctx.data.mergeAction = verdict.action
    // Only comment on a real block; a skip (already merged/closed) is silent.
    if (verdict.action === "MERGE_BLOCKED") {
      commentOnIssue(
        prNumber,
        `🚦 _Auto-merge held: ${verdict.reason} Kody will retry once the PR is CLEAN._`,
        ctx.cwd,
      )
    }
    return
  }

  process.stdout.write(`[merge] PR #${prNumber} is CLEAN — squash-merging\n`)
  const merged = mergePrSquash(prNumber, ctx.cwd)
  if (!merged.ok) {
    process.stderr.write(`[merge] squash-merge of PR #${prNumber} failed: ${merged.error}\n`)
    ctx.data.mergeAction = "MERGE_BLOCKED"
    commentOnIssue(
      prNumber,
      `🚦 _Auto-merge attempted but failed: ${merged.error}. Kody will retry next tick._`,
      ctx.cwd,
    )
    return
  }

  process.stdout.write(`[merge] PR #${prNumber} merged ✅\n`)
  ctx.data.mergeAction = "MERGE_COMPLETED"
}
