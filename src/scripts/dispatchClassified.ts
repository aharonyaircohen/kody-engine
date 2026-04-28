/**
 * Postflight (classify-only, runs LAST): post `@kody <classification>` to
 * dispatch the chosen sub-orchestrator.
 *
 * Why this is split from `recordClassification` and runs last:
 *   classify's postflight creates three new issue_comment events in quick
 *   succession (audit, state, dispatch). GitHub Actions concurrency keeps
 *   only the newest pending event in the same group; older pending events
 *   get cancelled. By posting the dispatch comment LAST we guarantee it's
 *   the surviving event, so the sub-orchestrator actually fires.
 *
 *   Subsequent orchestrators (bug/feature/spec/chore) avoid the race
 *   because they update an already-existing state comment via PATCH,
 *   which doesn't fire `issue_comment.created`. classify is the first
 *   run for the issue, so its state-comment write is a CREATE.
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript } from "../executables/types.js"
import type { Action } from "../state.js"

const API_TIMEOUT_MS = 30_000
const VALID_CLASSES = new Set(["feature", "bug", "spec", "chore"])

export const dispatchClassified: PostflightScript = async (ctx) => {
  const issueNumber = ctx.args.issue as number | undefined
  if (!issueNumber) return

  const classification = ctx.data.classification as string | undefined
  if (!classification || !VALID_CLASSES.has(classification)) return

  // Goes through execFileSync directly so it reaches GHA's issue_comment
  // filter; postIssueComment would sanitize the @kody mention out.
  try {
    execFileSync("gh", ["issue", "comment", String(issueNumber), "--body", `@kody ${classification}`], {
      cwd: ctx.cwd,
      timeout: API_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    process.stderr.write(
      `[kody dispatchClassified] failed to dispatch @kody ${classification}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    ctx.data.action = failedAction("dispatch post failed")
    ctx.output.exitCode = 1
    ctx.output.reason = "classify: dispatch failed"
  }
}

function failedAction(reason: string): Action {
  return { type: "CLASSIFY_FAILED", payload: { reason }, timestamp: new Date().toISOString() }
}
