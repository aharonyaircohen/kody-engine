/**
 * Preflight (ui-review): resolve the issue this PR is meant to deliver (a bug
 * fix OR a feature) and inject its description into the prompt, so the review
 * verifies the ORIGINAL intent — a reported bug is actually gone, or a
 * requested feature actually works — not merely that the diff is internally
 * correct. Without this, ui-review judges the PR against its own self-described
 * intent and PASSes a change whose code path is right but whose goal isn't met
 * (e.g. a "(unknown)" badge that persists for a separate env/config reason).
 *
 * Sets ctx.data.linkedFinding — a formatted "Issue #N: title\n\nbody" string,
 * or "" when no issue is linked. Fail-soft: any lookup failure leaves it empty
 * and the prompt section is simply omitted.
 */

import type { PreflightScript } from "../agent-actions/types.js"
import { getIssue, type PrData, truncate } from "../issue.js"

const FINDING_BODY_MAX_BYTES = 4000

function resolveFindingNumber(pr: PrData): number | null {
  // 1. head-branch convention: "<issue>-slug"
  const fromBranch = /^(\d+)-/.exec(pr.headRefName)?.[1]
  if (fromBranch) return Number(fromBranch)
  // 2. body references: "Fixes #N" / "Closes #N" / "Resolves #N"
  const m = /(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)/i.exec(pr.body)
  return m ? Number(m[1]) : null
}

export const loadLinkedFinding: PreflightScript = async (ctx) => {
  ctx.data.linkedFinding = ""

  const pr = ctx.data.pr as PrData | undefined
  if (!pr) return

  const findingNumber = resolveFindingNumber(pr)
  if (!findingNumber) return

  let issue: ReturnType<typeof getIssue>
  try {
    issue = getIssue(findingNumber, ctx.cwd)
  } catch {
    return // fail-soft: the PR may reference a non-existent/closed issue
  }

  ctx.data.linkedFinding = `Issue #${issue.number}: ${issue.title}\n\n${truncate(issue.body, FINDING_BODY_MAX_BYTES)}`
}
