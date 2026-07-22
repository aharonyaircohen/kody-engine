/**
 * Postflight for the `review` implementation. Takes the agent's final message
 * (which the prompt instructs to be the entire review body), removes any
 * preamble before the verdict, bounds its size, and posts it as a PR comment.
 * Decides exit code based on the extracted verdict:
 *   PASS     → exit 0
 *   CONCERNS → exit 0 (review is advisory)
 *   FAIL     → exit 1 (signals a blocking verdict to external callers)
 *   missing/empty → exit 1
 *
 * Emits a typed Action into ctx.data.action so `saveTaskState` (if present in
 * the profile postflight) records the review in history/lastOutcome. The
 * action type mirrors the verdict so downstream implementations (`fix`) can
 * dispatch on it.
 */

import type { AgentResult } from "../agent.js"
import type { PostflightScript } from "../implementations/types.js"
import { postPrReviewComment, truncate } from "../issue.js"
import type { Action } from "../state.js"

export type ReviewVerdict = "PASS" | "CONCERNS" | "FAIL" | "UNKNOWN"

export const MAX_REVIEW_WORDS = 600
const REVIEW_TRUNCATION_NOTE = "> Review truncated to the highest-priority findings."

function words(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean)
}

const FORBIDDEN_REVIEW_SECTION =
  /^(?:clean\b|strengths?\b|suggest(?:ion|ed)s?\b|follow[- ]?ups?\b|verification\b|notes?\b|nits?\b|non[- ]issues?\b)/i

function removeForbiddenReviewSections(body: string): string {
  const kept: string[] = []
  let skipping = false
  for (const line of body.split("\n")) {
    const heading = line.match(/^\s*(?:#{1,6}\s+(.+?)|\*\*(.+?)\*\*)\s*$/)
    if (heading) {
      const title = (heading[1] ?? heading[2] ?? "").replace(/[*_`]/g, "").trim()
      skipping = FORBIDDEN_REVIEW_SECTION.test(title)
    }
    if (!skipping) kept.push(line)
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function prepareReviewBody(rawBody: string): string {
  let body = rawBody.trim()
  const verdict = body.match(/(^|\n)(\s*#{1,6}\s*Verdict\s*:?\s*(?:PASS|CONCERNS|FAIL)\b)/i)
  if (verdict?.index !== undefined) {
    body = body.slice(verdict.index + verdict[1]!.length).trim()
  }
  body = removeForbiddenReviewSections(body)

  const bodyWords = words(body)
  if (bodyWords.length <= MAX_REVIEW_WORDS) return body

  const noteWords = words(REVIEW_TRUNCATION_NOTE)
  const retainedWordCount = MAX_REVIEW_WORDS - noteWords.length
  const matches = [...body.matchAll(/\S+/g)]
  const retainedEnd = matches[retainedWordCount - 1]!.index + matches[retainedWordCount - 1]![0].length
  return `${body.slice(0, retainedEnd).trimEnd()}\n\n${REVIEW_TRUNCATION_NOTE}`
}

function inferVerdictFromReviewText(body: string): ReviewVerdict {
  const structuredVerdict = body.match(/"verdict"\s*:\s*"(pass|concerns|fail|partial)"/i)
  if (structuredVerdict) {
    const value = structuredVerdict[1]!.toUpperCase()
    return value === "PARTIAL" ? "CONCERNS" : (value as ReviewVerdict)
  }
  const status = body.match(
    /(^|\n)\s*(?:#{1,6}\s*)?(?:\*\*Status:\*\*|Status:)\s*(PASS|CONCERNS|FAIL|WARN|NONE|BLOCK|NEEDS_CONTEXT)\b/i,
  )
  if (status) {
    const value = status[2]!.toUpperCase()
    if (value === "PASS" || value === "NONE") return "PASS"
    if (value === "CONCERNS" || value === "WARN") return "CONCERNS"
    return "FAIL"
  }
  if (/\bpartial\b/i.test(body) && /\b(finding|gap|unverified|unverifiable|blocker|issue)s?\b/i.test(body)) {
    return "CONCERNS"
  }
  if (/\b(blocking|blocker|must fix|should not merge|regression|breaks|security risk)\b/i.test(body)) return "FAIL"
  if (
    /\b(actionable item|suggestions?|worth clarifying|worth checking|minor note|non-blocking|deserves a comment)\b/i.test(
      body,
    ) ||
    /\b(improvement opportunit(?:y|ies)|more useful if|would be more useful|would be better|incomplete as standalone|leaving a gap)\b/i.test(
      body,
    )
  ) {
    return "CONCERNS"
  }
  if (
    /\bLGTM\b/i.test(body) ||
    /\blooks good\b/i.test(body) ||
    /\bgood PR\b/i.test(body) ||
    /\bno changes required\b/i.test(body) ||
    /\bno findings\b/i.test(body) ||
    /\ball checks pass\b/i.test(body) ||
    /\bimplementation is correct\b/i.test(body)
  ) {
    return "PASS"
  }
  return "UNKNOWN"
}

function extractVerdictSection(body: string): string | null {
  const heading = body.match(/(^|\n)\s*#{1,6}\s*Verdict\b\s*:?\s*/i)
  if (!heading || heading.index === undefined) return null

  const start = heading.index + heading[0].length
  const rest = body.slice(start)
  const nextHeading = rest.search(/\n\s*#{1,6}\s+\S/)
  return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest
}

export function detectVerdict(body: string): ReviewVerdict {
  const exact = body.match(/(^|\n)\s*#{1,6}\s*Verdict\s*:?\s*(PASS|CONCERNS|FAIL)\b/i)
  if (exact) return exact[2]!.toUpperCase() as ReviewVerdict

  const section = extractVerdictSection(body)
  if (!section) return inferVerdictFromReviewText(body)

  const explicit = section.match(/\b(PASS|CONCERNS|FAIL)\b/i)
  if (explicit) return explicit[1]!.toUpperCase() as ReviewVerdict

  const sectionVerdict = inferVerdictFromReviewText(section)
  if (sectionVerdict !== "UNKNOWN") return sectionVerdict

  return inferVerdictFromReviewText(body)
}

function reviewAction(verdict: ReviewVerdict, payload: Record<string, unknown>): Action {
  const type =
    verdict === "PASS"
      ? "REVIEW_PASS"
      : verdict === "CONCERNS"
        ? "REVIEW_CONCERNS"
        : verdict === "FAIL"
          ? "REVIEW_FAIL"
          : "REVIEW_COMPLETED"
  return { type, payload: { verdict, ...payload }, timestamp: new Date().toISOString() }
}

function failedAction(reason: string): Action {
  return { type: "REVIEW_FAILED", payload: { reason }, timestamp: new Date().toISOString() }
}

export const postReviewResult: PostflightScript = async (ctx, _profile, agentResult: AgentResult | null) => {
  const prNumber = ctx.data.commentTargetNumber as number | undefined
  if (!prNumber) {
    ctx.output.exitCode = 99
    ctx.output.reason = "review postflight: no PR number in context"
    ctx.data.action = failedAction(ctx.output.reason)
    return
  }

  if (!agentResult || agentResult.outcome !== "completed") {
    const reason = agentResult?.error ?? "agent did not complete"
    try {
      postPrReviewComment(prNumber, `⚠️ kody review FAILED: ${truncate(reason, 1000)}`, ctx.cwd)
    } catch {
      /* best effort */
    }
    ctx.output.exitCode = 1
    ctx.output.reason = reason
    ctx.data.action = failedAction(reason)
    return
  }

  const reviewBody = prepareReviewBody(agentResult.finalText)
  if (!reviewBody) {
    try {
      postPrReviewComment(prNumber, `⚠️ kody review FAILED: agent produced no review body`, ctx.cwd)
    } catch {
      /* best effort */
    }
    ctx.output.exitCode = 1
    ctx.output.reason = "empty review body"
    ctx.data.action = failedAction("empty review body")
    return
  }

  try {
    postPrReviewComment(prNumber, reviewBody, ctx.cwd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.output.exitCode = 4
    ctx.output.reason = `failed to post review comment: ${msg}`
    ctx.data.action = failedAction(ctx.output.reason)
    return
  }

  const verdict = detectVerdict(reviewBody)
  ctx.data.reviewVerdict = verdict
  ctx.data.reviewBody = reviewBody
  ctx.data.action = reviewAction(verdict, { bodyPreview: truncate(reviewBody, 500) })
  // FAIL is the only verdict that signals a blocking decision; PASS and
  // CONCERNS both exit 0 because the review is advisory.
  ctx.output.exitCode = verdict === "FAIL" ? 1 : 0
  process.stdout.write(
    `\nREVIEW_POSTED=https://github.com/${ctx.config.github.owner}/${ctx.config.github.repo}/pull/${prNumber} (verdict: ${verdict})\n`,
  )
}
