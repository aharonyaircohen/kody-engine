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
 *   fenceLabel  required — e.g. "kody-issue-next-state"
 *
 * Reads   ctx.data.issueStateComment (for previously-loaded rev)
 * Writes  ctx.data.nextIssueState ({ cursor, data, done } + computed rev)
 *         ctx.data.nextStateParseError (string) if the envelope was missing or invalid
 */

import type { PostflightScript } from "../implementations/types.js"
import type { LoadedStateComment } from "./issueStateComment.js"
import { extractNextStateFromText } from "./stateEnvelope.js"

export const parseIssueStateFromAgentResult: PostflightScript = async (ctx, _profile, agentResult, args) => {
  const fenceLabel = String(args?.fenceLabel ?? "")
  if (!fenceLabel) {
    throw new Error("parseIssueStateFromAgentResult: `with.fenceLabel` is required")
  }

  if (!agentResult) {
    ctx.data.nextStateParseError = "agent did not run"
    return
  }

  const loaded = ctx.data.issueStateComment as LoadedStateComment | null | undefined
  const prevRev = loaded?.state.rev ?? 0

  const result = extractNextStateFromText(agentResult.finalText, fenceLabel, prevRev)
  if (result.error) {
    // Preserve the legacy "did not emit" phrasing for the missing-block case
    // so existing tests / log scrapers keep matching; pass other errors
    // (malformed JSON, bad envelope shape) through verbatim.
    ctx.data.nextStateParseError = result.error.startsWith("missing `")
      ? `agent did not emit a \`${fenceLabel}\` fenced block`
      : result.error
    return
  }

  ctx.data.nextIssueState = result.envelope
}
