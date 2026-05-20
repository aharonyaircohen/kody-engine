/**
 * Postflight (classify-only): finalize the classification decision and
 * stash the audit text + typed action into ctx.data. Does NOT post any
 * comment in the success path — `dispatchClassified` posts a single
 * combined comment (dispatch + audit + state) so classify emits exactly
 * one `issue_comment.created` event into the kody concurrency group.
 *
 * Sources (in order):
 *   1. ctx.data.classification  — set by `classifyByLabel` when a label
 *                                  short-circuited the decision.
 *   2. agent output             — extracted from the `classification: X`
 *                                  line in ctx.data.prSummary (parsed by
 *                                  parseAgentResult earlier).
 *
 * Side effects (success path):
 *   - Sets `ctx.data.classification` and `ctx.data.classificationReason`
 *     for downstream scripts (writeRunSummary, dispatchClassified).
 *   - Sets `ctx.data.classificationAudit` — the human-readable audit
 *     line that dispatchClassified embeds in its combined comment.
 *   - Writes a typed action into ctx.data.action so dispatchClassified
 *     can apply it to ctx.data.taskState and render the state block.
 *
 * Side effects (failure path):
 *   - Posts a single audit comment explaining the decision could not be
 *     made and asks the user to re-run with an explicit `@kody <type>`.
 *     Safe to post here because no dispatch follows — no race.
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript } from "../executables/types.js"
import type { Action } from "../state.js"

const API_TIMEOUT_MS = 30_000
const VALID_CLASSES = new Set(["feature", "bug", "spec", "chore"])

export const recordClassification: PostflightScript = async (ctx) => {
  const issueNumber = ctx.args.issue as number | undefined
  if (!issueNumber) return

  const presetClassification = ctx.data.classification as string | undefined
  let classification: string | null = null
  let reason: string | null = null

  if (presetClassification && VALID_CLASSES.has(presetClassification)) {
    classification = presetClassification
    reason = (ctx.data.classificationReason as string | undefined) ?? "label-based match"
  } else {
    const parsed = parseClassification((ctx.data.prSummary as string | undefined) ?? "")
    classification = parsed?.classification ?? null
    reason = parsed?.reason ?? null
  }

  if (!classification) {
    ctx.data.action = failedAction("classification missing or invalid")
    tryAuditComment(
      issueNumber,
      "⚠️ kody classifier could not decide — please re-run with an explicit `@kody <type>`.",
      ctx.cwd,
    )
    ctx.output.exitCode = 1
    ctx.output.reason = "classify: no decision"
    return
  }

  ctx.data.action = makeAction(`CLASSIFIED_AS_${classification.toUpperCase()}`, {
    classification,
    reason: reason ?? "",
    source: (ctx.data.classificationSource as string | undefined) ?? "agent",
  })
  ctx.data.classification = classification
  ctx.data.classificationReason = reason ?? ""
  ctx.data.classificationAudit = `🔎 kody classified as \`${classification}\`${reason ? ` — ${reason}` : ""}`
}

export function parseClassification(prSummary: string): { classification: string; reason: string } | null {
  if (!prSummary) return null
  const classMatch = prSummary.match(/classification:\s*(feature|bug|spec|chore)\b/i)
  if (!classMatch) return null
  const classification = classMatch[1]!.toLowerCase()
  const reasonMatch = prSummary.match(/reason:\s*(.+)$/im)
  const reason = reasonMatch ? reasonMatch[1]!.trim() : ""
  return { classification, reason }
}

function tryAuditComment(issueNumber: number, body: string, cwd: string): void {
  try {
    execFileSync("gh", ["issue", "comment", String(issueNumber), "--body", body], {
      cwd,
      timeout: API_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch {
    /* best-effort — audit only */
  }
}

function makeAction(type: string, payload: Record<string, unknown>): Action {
  return { type, payload, timestamp: new Date().toISOString() }
}

function failedAction(reason: string): Action {
  return { type: "CLASSIFY_FAILED", payload: { reason }, timestamp: new Date().toISOString() }
}
