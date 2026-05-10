/**
 * Marker-rescue: the agent often finishes the work cleanly but ends with a
 * natural-language wrap-up instead of the literal `DONE` / `FAILED:` /
 * `COMMIT_MSG:` / `PR_SUMMARY:` sentinel parseAgentResult requires. Throwing
 * the run away over a missing five-letter token wastes a full agent
 * invocation and orphans a working branch.
 *
 * If the SDK reported success but the marker is missing, send one short
 * follow-up turn asking for the sentinel and append its output. Postflights
 * then re-parse the combined text and see DONE/FAILED.
 *
 * Pure helper — takes the original result and an `invoke` seam, no globals.
 */

import type { AgentResult } from "./agent.js"
import { parseAgentResult } from "./prompt.js"

const NUDGE_PROMPT =
  "Your previous message did not contain the required terminator. " +
  "Reply with EXACTLY one of:\n" +
  "  DONE\n" +
  "  COMMIT_MSG: <one-line commit message>\n" +
  "or, if the work failed:\n" +
  "  FAILED: <one-line reason>\n" +
  "Do not repeat any earlier content — emit only the marker line(s)."

export async function rescueMissingMarker(
  result: AgentResult,
  invoke: (prompt: string) => Promise<AgentResult>,
): Promise<AgentResult> {
  if (result.outcome !== "completed") return result
  const parsed = parseAgentResult(result.finalText)
  if (!parsed.markerMissing) return result

  try {
    const rescue = await invoke(NUDGE_PROMPT)
    if (!rescue.finalText || !rescue.finalText.trim()) return result
    return {
      ...result,
      finalText: `${result.finalText}\n\n---\n\n${rescue.finalText}`,
      outcome: rescue.outcome === "failed" ? result.outcome : rescue.outcome,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody] marker-rescue turn failed: ${msg}\n`)
    return result
  }
}
