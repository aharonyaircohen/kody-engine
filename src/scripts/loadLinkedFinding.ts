/**
 * Preflight (ui-review): resolve the QA finding issue this PR is meant to fix
 * and inject its reported symptom into the prompt, so the review verifies the
 * ORIGINAL user-reported bug is gone — not merely that the diff is internally
 * correct. Without this, ui-review judges the PR against its own self-described
 * intent and PASSes a fix whose code path is right but whose reported symptom
 * still reproduces (e.g. a "(unknown)" badge that persists for a separate
 * env/config reason).
 *
 * Sets ctx.data.linkedFinding — a formatted "Issue #N: title\n\nbody" string,
 * or "" when no QA finding is linked. Fail-soft: any lookup failure leaves it
 * empty and the prompt section is simply omitted.
 */

import type { PreflightScript } from "../executables/types.js"
import { getIssue, type PrData, truncate } from "../issue.js"

const QA_FINDING_LABEL = /^(severity:p\d|goal:qa|kody:qa-finding)/i
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

  let issue
  try {
    issue = getIssue(findingNumber, ctx.cwd)
  } catch {
    return // fail-soft: the PR may reference a non-existent/closed issue
  }

  const labels = issue.labels ?? []
  if (!labels.some((l) => QA_FINDING_LABEL.test(l))) return // only QA findings carry repro steps

  ctx.data.linkedFinding = `Issue #${issue.number}: ${issue.title}\n\n${truncate(issue.body, FINDING_BODY_MAX_BYTES)}`
}
