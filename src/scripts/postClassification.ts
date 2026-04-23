/**
 * Postflight (classify-only): finalize the classification and dispatch the
 * chosen sub-orchestrator.
 *
 * Sources (in order):
 *   1. ctx.data.classification  — set by `classifyByLabel` when a label
 *                                  short-circuited the decision.
 *   2. agent output             — extracted from the `classification: X`
 *                                  line in ctx.data.prSummary (parsed by
 *                                  parseAgentResult earlier).
 *
 * Side effects:
 *   - Posts an audit comment "🔎 kody classified as `<type>` — <reason>"
 *     on the issue (human-readable; sanitized so it doesn't self-trigger).
 *   - Posts `@kody <type>` on the issue via execFileSync directly so GHA
 *     picks it up and routes to the chosen sub-orchestrator.
 *   - Writes a typed action into ctx.data.action so saveTaskState records
 *     the outcome in state history.
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript } from "../executables/types.js"
import type { Action } from "../state.js"

const API_TIMEOUT_MS = 30_000
const VALID_CLASSES = new Set(["feature", "bug", "spec", "chore"])

export const postClassification: PostflightScript = async (ctx) => {
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
    tryAuditComment(issueNumber, "⚠️ kody classifier could not decide — please re-run with an explicit `@kody <type>`.", ctx.cwd)
    ctx.output.exitCode = 1
    ctx.output.reason = "classify: no decision"
    return
  }

  // Audit trail (human-readable, sanitized).
  tryAuditComment(
    issueNumber,
    `🔎 kody classified as \`${classification}\`${reason ? ` — ${reason}` : ""}`,
    ctx.cwd,
  )

  // Dispatch the chosen sub-orchestrator. Goes through execFileSync so it
  // reaches GHA's issue_comment filter; postIssueComment would sanitize.
  try {
    execFileSync("gh", ["issue", "comment", String(issueNumber), "--body", `@kody ${classification}`], {
      cwd: ctx.cwd,
      timeout: API_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    process.stderr.write(
      `[kody postClassification] failed to dispatch @kody ${classification}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    ctx.data.action = failedAction("dispatch post failed")
    ctx.output.exitCode = 1
    ctx.output.reason = "classify: dispatch failed"
    return
  }

  ctx.data.action = makeAction(`CLASSIFIED_AS_${classification.toUpperCase()}`, {
    classification,
    reason: reason ?? "",
    source: (ctx.data.classificationSource as string | undefined) ?? "agent",
  })
  ctx.data.classification = classification
  ctx.data.classificationReason = reason ?? ""
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
