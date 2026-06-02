/**
 * Postflight: extract the agent's proposed next state from a fenced code
 * block, validate it, and place it on ctx.data.nextJobState. Mirror of
 * `parseIssueStateFromAgentResult` for the file-based job model.
 *
 * Reads previous rev from ctx.data.jobState (loaded by loadJobFromFile).
 *
 * Script args (via `with:`):
 *   fenceLabel  required — e.g. "kody-job-next-state"
 *
 * Reads   ctx.data.jobState
 * Writes  ctx.data.nextJobState ({ version, rev, cursor, data, done })
 *         ctx.data.nextStateParseError on failure
 */

import type { PostflightScript } from "../executables/types.js"
import type { LoadedJobState } from "./jobState/index.js"
import { extractNextStateFromText } from "./stateEnvelope.js"

// Re-exported so existing callers (`runTickScript`) and tests keep importing
// the envelope parser from this module. The implementation lives in
// `stateEnvelope.ts`, shared with `parseIssueStateFromAgentResult`.
export { extractNextStateFromText } from "./stateEnvelope.js"

export const parseJobStateFromAgentResult: PostflightScript = async (ctx, _profile, agentResult, args) => {
  const fenceLabel = String(args?.fenceLabel ?? "")
  if (!fenceLabel) {
    throw new Error("parseJobStateFromAgentResult: `with.fenceLabel` is required")
  }

  if (!agentResult) {
    ctx.data.nextStateParseError = "agent did not run"
    return
  }

  const loaded = ctx.data.jobState as LoadedJobState | null | undefined
  const prevRev = loaded?.state.rev ?? 0

  // Preferred path: the agent called the `submit_state` tool (job-tick with
  // enableSubmitTool). A structured tool call can't be "forgotten" the way a
  // trailing fenced block can, so it's far more reliable. Fall through to the
  // fenced-block parse when the tool wasn't called (tool disabled, or the
  // model emitted the block the old way) — keeping this purely additive.
  const submitted = agentResult.submittedState
  if (submitted && typeof submitted.cursor === "string" && submitted.cursor.length > 0) {
    ctx.data.nextJobState = {
      version: 1,
      rev: prevRev + 1,
      cursor: submitted.cursor,
      data: submitted.data ?? {},
      done: Boolean(submitted.done),
    }
    return
  }

  const result = extractNextStateFromText(agentResult.finalText, fenceLabel, prevRev)
  if (result.error) {
    // Clean finish, nothing to save → benign no-op, not a failure.
    // Evergreen duties (approval-gate, qa) routinely check their queue, find
    // nothing actionable, and stop on their own without proposing new state.
    // When the agent COMPLETED successfully and simply emitted no block (not a
    // *malformed* one), carry the prior state forward so the tick succeeds
    // instead of being flagged "Duty failed". A genuinely cut-off run
    // (outcome="failed": max_turns, error, stalled) still falls through to the
    // loud parse-error path below — there, missing state means the agent never
    // reached its decision, which IS a real failure worth surfacing.
    const cleanFinishNoBlock =
      result.error.startsWith("missing `") && agentResult.outcome === "completed" && loaded != null
    if (cleanFinishNoBlock) {
      ctx.data.nextJobState = {
        version: 1,
        rev: prevRev + 1,
        cursor: loaded.state.cursor,
        data: loaded.state.data,
        done: loaded.state.done,
      }
      return
    }
    // Preserve the legacy phrasing for the missing-block case so existing
    // tests / log scrapers keep matching.
    ctx.data.nextStateParseError = result.error.startsWith("missing `")
      ? `agent did not emit a \`${fenceLabel}\` fenced block`
      : result.error
    return
  }
  ctx.data.nextJobState = result.envelope
}
