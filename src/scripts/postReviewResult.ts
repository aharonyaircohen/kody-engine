/**
 * Postflight for the `review` executable. Takes the agent's final message
 * (which the prompt instructs to be the entire review body) and posts it
 * verbatim as a PR comment. Decides exit code based on the extracted verdict:
 *   PASS     → exit 0
 *   CONCERNS → exit 0 (review is advisory)
 *   FAIL     → exit 1 (signals a blocking verdict to external callers)
 *   missing/empty → exit 1
 */

import type { AgentResult } from "../agent.js"
import type { PostflightScript } from "../executables/types.js"
import { postPrReviewComment, truncate } from "../issue.js"

export type ReviewVerdict = "PASS" | "CONCERNS" | "FAIL" | "UNKNOWN"

export function detectVerdict(body: string): ReviewVerdict {
  const m = body.match(/##\s*Verdict\s*:\s*(PASS|CONCERNS|FAIL)\b/i)
  if (!m) return "UNKNOWN"
  return m[1]!.toUpperCase() as ReviewVerdict
}

export const postReviewResult: PostflightScript = async (ctx, _profile, agentResult: AgentResult | null) => {
  const prNumber = ctx.data.commentTargetNumber as number | undefined
  if (!prNumber) {
    ctx.output.exitCode = 99
    ctx.output.reason = "review postflight: no PR number in context"
    return
  }

  if (!agentResult || agentResult.outcome !== "completed") {
    const reason = agentResult?.error ?? "agent did not complete"
    try {
      postPrReviewComment(prNumber, `⚠️ kody2 review FAILED: ${truncate(reason, 1000)}`, ctx.cwd)
    } catch { /* best effort */ }
    ctx.output.exitCode = 1
    ctx.output.reason = reason
    return
  }

  const reviewBody = agentResult.finalText.trim()
  if (!reviewBody) {
    try {
      postPrReviewComment(prNumber, `⚠️ kody2 review FAILED: agent produced no review body`, ctx.cwd)
    } catch { /* best effort */ }
    ctx.output.exitCode = 1
    ctx.output.reason = "empty review body"
    return
  }

  try {
    postPrReviewComment(prNumber, reviewBody, ctx.cwd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.output.exitCode = 4
    ctx.output.reason = `failed to post review comment: ${msg}`
    return
  }

  const verdict = detectVerdict(reviewBody)
  ctx.data.reviewVerdict = verdict
  // FAIL is the only verdict that signals a blocking decision; PASS and
  // CONCERNS both exit 0 because the review is advisory.
  ctx.output.exitCode = verdict === "FAIL" ? 1 : 0
  process.stdout.write(`\nREVIEW_POSTED=https://github.com/${ctx.config.github.owner}/${ctx.config.github.repo}/pull/${prNumber} (verdict: ${verdict})\n`)
}
