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
 * Fence-label aliases. The `kody-job-next-state` label is the canonical one
 * (kept that way to avoid breaking every existing duty in the wild). The
 * `kody-duty-next-state` label is the new wording introduced alongside the
 * duty-pipeline rename; if the configured label yields no block, the
 * alias is also tried before the parse fails. Either label is accepted
 * regardless of which one the profile declares.
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

const DUTY_NEXT_STATE_FENCE_ALIASES: Record<string, string> = {
  "kody-job-next-state": "kody-duty-next-state",
  "kody-duty-next-state": "kody-job-next-state",
}

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

  // Preferred path: the agent called the `submit_state` tool (duty-tick with
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

  // Try the configured label first, then the alias (if one is registered for
  // it). The error message — including the "agent did not emit a … fenced
  // block" phrasing — always names the configured label, since that's what
  // the profile's prompt actually tells the agent to emit. But a non-missing
  // error from the alias (malformed JSON, bad shape) is more informative than
  // "no block" and SHOULD be surfaced, since it tells the operator the
  // agent DID emit an alias block, just incorrectly.
  let result = extractNextStateFromText(agentResult.finalText, fenceLabel, prevRev)
  if (result.error?.startsWith("missing `")) {
    const alias = DUTY_NEXT_STATE_FENCE_ALIASES[fenceLabel]
    if (alias) {
      const aliasResult = extractNextStateFromText(agentResult.finalText, alias, prevRev)
      if (!aliasResult.error?.startsWith("missing `")) {
        result = aliasResult
      }
    }
  }
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
