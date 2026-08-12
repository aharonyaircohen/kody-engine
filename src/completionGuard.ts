const MAX_COMPLETION_RESERVE_MS = 10 * 60_000

/**
 * Leave the final third of a bounded run for concluding the work, capped at
 * ten minutes.
 */
export function completionToolCutoffAt(startedAtMs: number, deadlineAtMs: number): number {
  const availableMs = Math.max(0, deadlineAtMs - startedAtMs)
  const reserveMs = Math.min(MAX_COMPLETION_RESERVE_MS, Math.floor(availableMs / 3))
  return deadlineAtMs - reserveMs
}

export function createCompletionToolGuard(
  cutoffAtMs: number,
  now: () => number = Date.now,
): () => Promise<Record<string, unknown>> {
  return async () => {
    if (now() < cutoffAtMs) return {}
    return {
      decision: "block",
      reason:
        "The run has entered its reserved completion window. Do not call more tools. " +
        "Use the evidence and changes already present, state any verification limits clearly, and return your final response now.",
    }
  }
}
