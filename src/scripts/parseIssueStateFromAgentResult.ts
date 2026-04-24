/**
 * Postflight: extract the agent's proposed next state from a dedicated
 * fenced code block in the agent's final message, validate, place on
 * ctx.data.nextIssueState.
 *
 * The agent must emit a single fenced block using the configured language
 * tag. Anything else is ignored.
 *
 *     ```<fenceLabel>
 *     { "cursor": "...", "data": { ... }, "done": false }
 *     ```
 *
 * rev is NOT provided by the agent — the writer script bumps it based on
 * the previously-loaded rev. Keeps the agent from having to track it.
 *
 * Script args (via `with:`):
 *   fenceLabel  required — e.g. "kody-manager-next-state"
 *
 * Reads   ctx.data.issueStateComment (for previously-loaded rev)
 * Writes  ctx.data.nextIssueState ({ cursor, data, done } + computed rev)
 *         ctx.data.nextStateParseError (string) if the envelope was missing or invalid
 */

import type { PostflightScript } from "../executables/types.js"
import type { LoadedStateComment, StateEnvelope } from "./issueStateComment.js"

interface PartialEnvelope {
  cursor: string
  data: Record<string, unknown>
  done: boolean
}

function isPartialEnvelope(x: unknown): x is PartialEnvelope {
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

export const parseIssueStateFromAgentResult: PostflightScript = async (ctx, _profile, agentResult, args) => {
  const fenceLabel = String(args?.fenceLabel ?? "")
  if (!fenceLabel) {
    throw new Error("parseIssueStateFromAgentResult: `with.fenceLabel` is required")
  }

  if (!agentResult) {
    ctx.data.nextStateParseError = "agent did not run"
    return
  }

  const fenceRegex = new RegExp("```" + escapeRegex(fenceLabel) + "\\s*\\n([\\s\\S]*?)\\n```", "m")
  const match = fenceRegex.exec(agentResult.finalText)
  if (!match) {
    ctx.data.nextStateParseError = `agent did not emit a \`${fenceLabel}\` fenced block`
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1]!.trim())
  } catch (err) {
    ctx.data.nextStateParseError = `state JSON parse error: ${err instanceof Error ? err.message : String(err)}`
    return
  }

  if (!isPartialEnvelope(parsed)) {
    ctx.data.nextStateParseError =
      "state must be an object with string `cursor`, object `data`, and boolean `done`"
    return
  }

  const loaded = ctx.data.issueStateComment as LoadedStateComment | null | undefined
  const prevRev = loaded?.state.rev ?? 0

  const next: StateEnvelope = {
    version: 1,
    rev: prevRev + 1,
    cursor: parsed.cursor,
    data: parsed.data,
    done: parsed.done,
  }
  ctx.data.nextIssueState = next
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
}
