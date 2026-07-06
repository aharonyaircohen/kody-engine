/**
 * Postflight: extract reproduce-specific fields from the agent's final
 * message — TEST_PATH and FAILURE_SIGNATURE — and stuff them into ctx.data
 * so persistArtifacts can promote them into the task-state's `artifacts`
 * map and verifyReproFails can consume them.
 *
 * Must run AFTER parseAgentResult (which sets agentDone, prSummary, etc.)
 * and BEFORE verifyReproFails (which reads the parsed values).
 *
 * Format expected from the agent:
 *
 *   DONE
 *   TEST_PATH: tests/repro-issue-42.test.ts
 *   FAILURE_SIGNATURE:
 *   ```
 *   {
 *     "errorType": "AssertionError",
 *     "messageContains": "expected 5 but got 4",
 *     "stackContains": "src/calc.ts"
 *   }
 *   ```
 *   COMMIT_MSG: test: ...
 *   PR_SUMMARY: ...
 *
 * If the agent didn't emit DONE, this script no-ops — parseAgentResult
 * already produced a REPRODUCE_FAILED action.
 *
 * If the agent emitted DONE but the structured fields are missing or
 * malformed, this script downgrades the action to REPRODUCE_FAILED with a
 * specific reason.
 */

import type { PostflightScript } from "../implementations/types.js"
import type { Action } from "../state.js"

export interface ReproFailureSignature {
  errorType: string
  messageContains: string
  stackContains?: string
}

export const parseReproOutput: PostflightScript = async (ctx, _profile, agentResult) => {
  // No agent or already failed → leave the existing action alone.
  if (!agentResult || ctx.data.agentDone === false) return

  const text = agentResult.finalText ?? ""

  const testPath = extractTestPath(text)
  const signatureRaw = extractFailureSignatureBlock(text)

  if (!testPath) {
    downgrade(ctx, "reproduce missing TEST_PATH line in final message")
    return
  }

  let signature: ReproFailureSignature | null = null
  if (signatureRaw) {
    try {
      const parsed = JSON.parse(signatureRaw) as Partial<ReproFailureSignature>
      if (typeof parsed.errorType === "string" && typeof parsed.messageContains === "string") {
        signature = {
          errorType: parsed.errorType,
          messageContains: parsed.messageContains,
          stackContains: typeof parsed.stackContains === "string" ? parsed.stackContains : "",
        }
      }
    } catch {
      /* fall through */
    }
  }

  if (!signature) {
    downgrade(ctx, "reproduce missing or malformed FAILURE_SIGNATURE JSON (must contain errorType + messageContains)")
    return
  }

  ctx.data.reproTestPath = testPath
  ctx.data.reproFailureSignature = JSON.stringify(signature)
}

function extractTestPath(text: string): string {
  const m = text.match(/^[\s>*_#`~-]*TEST_PATH[\s>*_#`~-]*\s*:\s*(.+?)\s*$/im)
  if (!m) return ""
  return stripMarkdownEmphasis(m[1] ?? "")
}

/**
 * Pull the JSON block following `FAILURE_SIGNATURE:`. Tolerates an optional
 * fenced ```json``` wrapper and stops at the next top-level marker
 * (COMMIT_MSG / PR_SUMMARY) or end-of-text.
 */
function extractFailureSignatureBlock(text: string): string {
  const startIdx = text.search(/(?:^|\n)[ \t]*FAILURE_SIGNATURE\s*:[ \t]*/i)
  if (startIdx === -1) return ""
  const afterMarker = text.slice(startIdx).replace(/^[\s\S]*?FAILURE_SIGNATURE\s*:[ \t]*\n?/i, "")

  const stopRe = /(?:^|\n)[ \t]*(?:COMMIT_MSG|PR_SUMMARY|TEST_PATH)\s*:/i
  const stopIdx = afterMarker.search(stopRe)
  let block = stopIdx === -1 ? afterMarker : afterMarker.slice(0, stopIdx)
  block = block.trim()

  return normalizeFailureSignatureBlock(block)
}

function normalizeFailureSignatureBlock(block: string): string {
  let s = block.trim()
  while (/^```(?:json)?\s*/i.test(s) && /```\s*$/i.test(s)) {
    const next = s
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim()
    if (next === s) break
    s = next
  }

  const jsonObject = extractFirstJsonObject(s)
  return jsonObject || s
}

function extractFirstJsonObject(text: string): string {
  const start = text.indexOf("{")
  if (start === -1) return ""

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === "{") {
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1).trim()
    }
  }
  return ""
}

function stripMarkdownEmphasis(s: string): string {
  return s
    .trim()
    .replace(/^[*_`~]+|[*_`~]+$/g, "")
    .trim()
}

function downgrade(ctx: { data: Record<string, unknown> }, reason: string): void {
  const action = ctx.data.action as Action | undefined
  if (action?.type.endsWith("_COMPLETED")) {
    ctx.data.action = {
      type: action.type.replace(/_COMPLETED$/, "_FAILED"),
      payload: { reason, downgradedFrom: action.type },
      timestamp: new Date().toISOString(),
    }
  }
  ctx.data.agentFailureReason = reason
  ctx.data.agentDone = false
}
