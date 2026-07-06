/**
 * Shared parsing for the "labeled fenced JSON state envelope" protocol.
 *
 * Several implementations ask the agent (or a deterministic tick script) to emit
 * its proposed next state as a single fenced code block tagged with a known
 * label:
 *
 *     ```kody-job-next-state
 *     { "cursor": "...", "data": { ... }, "done": false }
 *     ```
 *
 * `extractFencedBlock` is the generic primitive (pull the inner text of a
 * ```<label> … ``` block). `extractNextStateFromText` layers the envelope
 * validation + rev-bump on top. Both `parseIssueStateFromAgentResult` and
 * `parseJobStateFromAgentResult` (and, via the latter, `runTickScript`) share
 * this one implementation instead of each re-rolling the fence regex.
 *
 * `rev` is never supplied by the agent — the caller passes the previously
 * loaded rev and this bumps it, so the agent can't desync the counter.
 */

import type { StateEnvelope } from "./issueStateComment.js"

interface PartialEnvelope {
  cursor: string
  data: Record<string, unknown>
  done: boolean
}

/** Structural guard for the agent-supplied portion of a state envelope. */
export function isPartialEnvelope(x: unknown): x is PartialEnvelope {
  if (x === null || typeof x !== "object") return false
  const o = x as Record<string, unknown>
  return (
    typeof o.cursor === "string" &&
    o.cursor.length > 0 &&
    typeof o.done === "boolean" &&
    o.data !== null &&
    typeof o.data === "object" &&
    !Array.isArray(o.data)
  )
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
}

/**
 * Return the trimmed inner text of a ```<label> … ``` fenced block, or null
 * when no such block is present. The label is matched literally (regex-special
 * characters escaped). An empty-but-present block returns "" (not null) so
 * callers can distinguish "no block" from "empty block".
 */
export function extractFencedBlock(text: string, label: string): string | null {
  const re = new RegExp(`\`\`\`${escapeRegex(label)}\\s*\\n([\\s\\S]*?)\\n\`\`\``, "m")
  const m = re.exec(text)
  return m ? m[1]!.trim() : null
}

/**
 * Extract a labeled fenced JSON block from arbitrary text and validate it as
 * a partial state envelope. Returns `{ envelope }` on success or `{ error }`
 * with a human-readable reason. Callers decide whether to set
 * `ctx.data.nextStateParseError` vs. throwing.
 */
export function extractNextStateFromText(
  text: string,
  fenceLabel: string,
  prevRev: number,
): { envelope: StateEnvelope; error?: undefined } | { error: string; envelope?: undefined } {
  const inner = extractFencedBlock(text, fenceLabel)
  if (inner === null) {
    return { error: `missing \`${fenceLabel}\` fenced block` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(inner)
  } catch (err) {
    return { error: `state JSON parse error: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (!isPartialEnvelope(parsed)) {
    return { error: "state must be an object with string `cursor`, object `data`, and boolean `done`" }
  }

  const envelope: StateEnvelope = {
    version: 1,
    rev: prevRev + 1,
    cursor: parsed.cursor,
    data: parsed.data,
    done: parsed.done,
  }
  return { envelope }
}
