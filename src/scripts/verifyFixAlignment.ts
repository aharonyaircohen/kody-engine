/**
 * Postflight for the `fix` executable: check that the commit actually
 * addresses the locations the review named.
 *
 * Correctness is anchored to file:line references in the review body, not
 * to bullet counts. The review is markdown-prose; each `path/file.ts:N`
 * mention is a concrete location the reviewer pointed at. We require the
 * commit to touch every such file at least once, unless the agent's
 * FEEDBACK_ACTIONS explicitly lists that file as `declined:` with a reason.
 *
 * Enforcement order (each exits on first match):
 *   A. Agent emitted zero FEEDBACK_ACTIONS items → FIX_FAILED.
 *   B. Any item says `fixed: …` but nothing was committed → FIX_FAILED.
 *   C. Review named file paths and the commit doesn't touch any of them
 *      (and they weren't explicitly declined) → FIX_FAILED.
 *   D. All items declined with no commit → FIX_DECLINED (graceful path).
 *
 * Must run AFTER parseAgentResult + commitAndPush, and BEFORE postIssueComment
 * / saveTaskState so the adjusted action reaches them.
 */

import type { PostflightScript } from "../executables/types.js"
import type { Action } from "../state.js"

export interface FeedbackActionsSummary {
  totalItems: number
  fixedItems: number
  declinedItems: number
  unparsedLines: number
}

/**
 * Parse the raw FEEDBACK_ACTIONS block. Each bullet is one item; the trailing
 * text must start with `fixed:` or `declined:` (case-insensitive). Other
 * bullets count toward the total but as `unparsedLines`.
 */
export function summarizeFeedbackActions(block: string): FeedbackActionsSummary {
  const summary: FeedbackActionsSummary = { totalItems: 0, fixedItems: 0, declinedItems: 0, unparsedLines: 0 }
  if (!block.trim()) return summary
  for (const raw of block.split("\n")) {
    if (!/^\s*[-*]\s+/.test(raw)) continue
    const line = raw.replace(/^\s*[-*]\s*/, "").trim()
    summary.totalItems++
    if (/\bfixed\s*:/i.test(line)) summary.fixedItems++
    else if (/\bdeclined\s*:/i.test(line)) summary.declinedItems++
    else summary.unparsedLines++
  }
  return summary
}

/**
 * Extract `path/file.ext[:line]` references from a review body. Dedup by file
 * path (ignore line numbers — we only check that the file was touched).
 * Only source-like paths are kept: the path must contain a `/`, end with a
 * code/test-file extension, and not start with a URL scheme.
 */
export function extractReviewFileRefs(reviewBody: string): string[] {
  if (!reviewBody) return []
  const found = new Set<string>()
  // Match backticked paths first (reviewers tend to wrap file refs in ``).
  const backtick = /`([^`\s]+\.[a-zA-Z]{1,5})(?::\d+(?:-\d+)?)?`/g
  let m: RegExpExecArray | null
  while ((m = backtick.exec(reviewBody)) !== null) {
    const raw = m[1]!
    if (isPlausibleSourcePath(raw)) found.add(raw)
  }
  // Also match bare-text paths (e.g. "src/foo.ts:42") that aren't backticked.
  const bare = /(?<![A-Za-z0-9/_.-])((?:[A-Za-z0-9_./-]+\/)+[A-Za-z0-9_.-]+\.[a-zA-Z]{1,5})(?::\d+(?:-\d+)?)?/g
  while ((m = bare.exec(reviewBody)) !== null) {
    const raw = m[1]!
    if (isPlausibleSourcePath(raw)) found.add(raw)
  }
  return Array.from(found)
}

function isPlausibleSourcePath(p: string): boolean {
  if (p.startsWith("http://") || p.startsWith("https://")) return false
  if (p.startsWith("//")) return false // URL remnants like //example.com/baz.ts
  if (p.startsWith("/")) return false // absolute paths: most review refs are repo-relative
  if (!p.includes("/")) return false // bare filenames too ambiguous
  if (/\.(md|rst|txt|png|jpg|jpeg|gif|svg|pdf)$/i.test(p)) return false
  // Reject domain-like first segments (contain a `.` before any `/`).
  const firstSeg = p.slice(0, p.indexOf("/"))
  if (firstSeg.includes(".")) return false
  return true
}

/**
 * Return the subset of `refs` that the `declined:` items in the FEEDBACK_ACTIONS
 * block mention. A declined file is "accounted for" — we don't require the
 * commit to touch it.
 */
export function declinedFileRefs(feedbackActions: string, refs: string[]): Set<string> {
  if (!feedbackActions.trim() || refs.length === 0) return new Set()
  const declined = new Set<string>()
  for (const raw of feedbackActions.split("\n")) {
    if (!/^\s*[-*]\s+/.test(raw)) continue
    if (!/\bdeclined\s*:/i.test(raw)) continue
    for (const ref of refs) {
      if (raw.includes(ref)) declined.add(ref)
    }
  }
  return declined
}

function makeAction(type: string, payload: Record<string, unknown>): Action {
  return { type, payload, timestamp: new Date().toISOString() }
}

export const verifyFixAlignment: PostflightScript = async (ctx, profile) => {
  if (profile.name !== "fix") return
  if (ctx.skipAgent) return
  if (!ctx.data.agentDone) return

  const feedbackActions = (ctx.data.feedbackActions as string | undefined) ?? ""
  const summary = summarizeFeedbackActions(feedbackActions)
  ctx.data.feedbackActionsSummary = summary

  const committed = Boolean((ctx.data.commitResult as { committed?: boolean } | undefined)?.committed)

  // A. No items at all.
  if (summary.totalItems === 0) {
    return failOnce(ctx, "FIX_FAILED", "fix produced no FEEDBACK_ACTIONS items", summary)
  }

  // B. Claimed fixed, nothing committed.
  if (summary.fixedItems > 0 && !committed) {
    return failOnce(
      ctx,
      "FIX_FAILED",
      `fix claimed ${summary.fixedItems} fixed item(s) but produced no commit`,
      summary,
    )
  }

  // C. Review named files; commit doesn't touch the non-declined ones.
  const reviewBody = (ctx.data.feedback as string | undefined) ?? ""
  const refs = extractReviewFileRefs(reviewBody)
  const changedFiles = ((ctx.data.changedFiles as string[] | undefined) ?? []).map((f) => f.trim()).filter(Boolean)
  ctx.data.reviewFileRefs = refs

  if (refs.length > 0 && committed) {
    const declined = declinedFileRefs(feedbackActions, refs)
    const missing = refs.filter((r) => !declined.has(r) && !changedFiles.some((f) => filesMatch(f, r)))
    if (missing.length > 0) {
      return failOnce(
        ctx,
        "FIX_FAILED",
        `fix did not touch review-named file(s): ${missing.join(", ")} — address them or mark declined with a reason`,
        summary,
        { missingFiles: missing, declinedFiles: Array.from(declined), changedFiles },
      )
    }
  }

  // D. All declined, no commit — graceful.
  if (summary.fixedItems === 0 && summary.declinedItems > 0 && !committed) {
    ctx.data.action = makeAction("FIX_DECLINED", {
      feedbackActionsSummary: summary,
      note: "agent declined all feedback items; no commit made",
    })
  }
}

function failOnce(
  ctx: Parameters<PostflightScript>[0],
  type: string,
  reason: string,
  summary: FeedbackActionsSummary,
  extra?: Record<string, unknown>,
): void {
  ctx.output.exitCode = 1
  ctx.output.reason = reason
  ctx.data.agentDone = false
  ctx.data.action = makeAction(type, {
    reason,
    feedbackActionsSummary: summary,
    ...(extra ?? {}),
  })
}

/**
 * True when a changed-file path matches a review-named reference. We compare
 * by suffix to tolerate reviewers quoting partial paths ("services/foo.ts")
 * while git reports repo-root paths ("src/services/foo.ts").
 */
function filesMatch(changedPath: string, reviewRef: string): boolean {
  if (changedPath === reviewRef) return true
  if (changedPath.endsWith("/" + reviewRef)) return true
  if (reviewRef.endsWith("/" + changedPath)) return true
  // Loose: same basename + overlapping segment. Keep this narrow to avoid
  // matching unrelated files that happen to share a filename.
  const a = changedPath.split("/")
  const b = reviewRef.split("/")
  if (a[a.length - 1] !== b[b.length - 1]) return false
  // Require 2+ overlapping trailing segments to match (basename + parent dir).
  return a.length >= 2 && b.length >= 2 && a[a.length - 2] === b[b.length - 2]
}
