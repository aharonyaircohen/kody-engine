/**
 * Preflight for the `review` executable. Checks out the PR, fetches
 * diff + metadata, posts a "started" comment. Read-only — no branch
 * modification, no conventions about commits. Sets:
 *   ctx.data.pr, ctx.data.prDiff, ctx.data.branch,
 *   ctx.data.commentTargetType = "pr", ctx.data.commentTargetNumber.
 */

import { checkoutPrBranch, getCurrentBranch } from "../branch.js"
import type { PreflightScript } from "../executables/types.js"
import { getRunUrl } from "../gha.js"
import { getPr, getPrDiff, postPrReviewComment } from "../issue.js"

export const reviewFlow: PreflightScript = async (ctx) => {
  const prNumber = ctx.args.pr as number
  const pr = getPr(prNumber, ctx.cwd)

  if (pr.state !== "OPEN") {
    ctx.output.exitCode = 1
    ctx.output.reason = `PR #${prNumber} is not OPEN (state: ${pr.state})`
    ctx.skipAgent = true
    return
  }

  ctx.data.pr = pr
  ctx.data.commentTargetType = "pr"
  ctx.data.commentTargetNumber = prNumber

  checkoutPrBranch(prNumber, ctx.cwd)
  ctx.data.branch = getCurrentBranch(ctx.cwd)
  ctx.data.prDiff = getPrDiff(prNumber, ctx.cwd)

  const runUrl = getRunUrl()
  const runSuffix = runUrl ? `, run ${runUrl}` : ""
  tryPostPr(prNumber, `👀 kody review started on PR #${prNumber}${runSuffix}`, ctx.cwd)
}

function tryPostPr(prNumber: number, body: string, cwd?: string): void {
  try {
    postPrReviewComment(prNumber, body, cwd)
  } catch {
    /* best effort */
  }
}
