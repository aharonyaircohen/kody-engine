import type { SubmittedState } from "./submitMcp.js"

const FINAL_STATE_CHANCE_REASON =
  "Before finishing, call `submit_state` exactly once with the next non-empty `cursor`, compact durable `data`, and the correct `done` value. Do not perform more work; submit only the continuation state now."

const STATE_ALREADY_SUBMITTED_REASON =
  "Continuation state is already submitted for this cycle. Do not call more tools or perform more work; return your final response now."

/** Make state submission the terminal action of one Live Agent cycle. */
export function createPostSubmitToolGuard(
  getSubmitted: () => SubmittedState | undefined,
): () => Promise<Record<string, unknown>> {
  return async () =>
    getSubmitted()
      ? {
          decision: "block",
          reason: STATE_ALREADY_SUBMITTED_REASON,
        }
      : {}
}

/**
 * Give a stateful agent one final turn to satisfy its durable state contract.
 * A second stop is allowed through so the deterministic postflight remains the
 * authority that rejects a missing or invalid state.
 */
export function createSubmitStateStopHook(
  getSubmitted: () => SubmittedState | undefined,
): () => Promise<Record<string, unknown>> {
  let finalChanceGiven = false

  return async () => {
    if (getSubmitted()) return {}
    if (finalChanceGiven) return {}
    finalChanceGiven = true
    return {
      decision: "block",
      reason: FINAL_STATE_CHANCE_REASON,
    }
  }
}
