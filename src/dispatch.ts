/**
 * Auto-detect which Build mode to run from the GHA event payload and the
 * triggering comment's body.
 *
 *   - issue_comment on an issue ............ run
 *   - issue_comment on a PR, bare `@kody2` .. fix
 *   - issue_comment containing `fix-ci` ..... fix-ci
 *   - issue_comment containing `resolve` .... resolve
 *   - issue_comment containing `fix` ........ fix
 *   - workflow_dispatch ..................... run (issue_number input)
 *
 * All keywords are case-insensitive and matched against the comment body
 * after the `@kody2` trigger. First match wins in the priority order above.
 */

import * as fs from "node:fs"

export interface DispatchResult {
  mode: "run" | "fix" | "fix-ci" | "resolve"
  /** Issue number for run; PR number for fix/fix-ci/resolve. */
  target: number
  /** Inline feedback extracted from the trigger comment body (fix mode). */
  feedback?: string
}

export function autoDispatch(explicit?: { mode?: string; target?: number }): DispatchResult | null {
  if (explicit?.mode && explicit.target) {
    return {
      mode: explicit.mode as DispatchResult["mode"],
      target: explicit.target,
    }
  }

  const eventName = process.env.GITHUB_EVENT_NAME
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventName || !eventPath || !fs.existsSync(eventPath)) return null

  let event: Record<string, any> = {}
  try {
    event = JSON.parse(fs.readFileSync(eventPath, "utf-8"))
  } catch {
    return null
  }

  if (eventName === "workflow_dispatch") {
    const n = parseInt(String(event.inputs?.issue_number ?? ""), 10)
    if (!Number.isNaN(n) && n > 0) return { mode: "run", target: n }
    return null
  }

  if (eventName === "issue_comment") {
    const body = String(event.comment?.body ?? "").toLowerCase()
    const issueNum = Number(event.issue?.number ?? 0)
    const isPr = !!event.issue?.pull_request
    if (!issueNum) return null

    // Mode selection from comment body. Keywords are checked on the portion
    // AFTER the @kody2 trigger phrase to avoid false positives.
    const afterTag = extractAfterTag(body)

    if (isPr) {
      if (/\bfix-ci\b/.test(afterTag)) return { mode: "fix-ci", target: issueNum }
      if (/\bresolve\b/.test(afterTag)) return { mode: "resolve", target: issueNum }
      const feedbackText = extractFeedback(afterTag)
      // Bare @kody2 on a PR or explicit 'fix' → fix mode.
      return { mode: "fix", target: issueNum, feedback: feedbackText }
    }

    // On an issue → always run mode.
    return { mode: "run", target: issueNum }
  }

  return null
}

/**
 * Pull the body text that follows `@kody2` (if present). If `@kody2` doesn't
 * appear, return the whole body. Lowercased.
 */
function extractAfterTag(body: string): string {
  const idx = body.indexOf("@kody2")
  if (idx === -1) return body
  return body.slice(idx + "@kody2".length).trim()
}

/**
 * Extract inline feedback from a PR comment body. We treat anything after
 * `@kody2` (and after a leading verb like "fix"/"please") as the feedback
 * payload. Empty string if nothing worth passing through — fix mode will
 * then fall back to the latest PR review body.
 */
function extractFeedback(afterTag: string): string | undefined {
  const cleaned = afterTag.replace(/^(fix|please|kindly)[\s:,.-]+/i, "").trim()
  return cleaned.length > 0 ? cleaned : undefined
}
