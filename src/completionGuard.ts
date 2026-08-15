import * as path from "node:path"

const MAX_COMPLETION_RESERVE_MS = 2 * 60_000

interface CompletionToolInput {
  tool_name?: unknown
  tool_input?: unknown
}

/**
 * Leave a small final window for concluding the model turn and running
 * deterministic postflights. Reserving a percentage of a long run can remove
 * most of the agent's implementation time, so the reserve is capped at two
 * minutes.
 */
export function completionToolCutoffAt(startedAtMs: number, deadlineAtMs: number): number {
  const availableMs = Math.max(0, deadlineAtMs - startedAtMs)
  const reserveMs = Math.min(MAX_COMPLETION_RESERVE_MS, Math.floor(availableMs / 2))
  return deadlineAtMs - reserveMs
}

export function createCompletionToolGuard(
  cutoffAtMs: number,
  now: () => number = Date.now,
  requiredOutputPath?: string,
): (input?: CompletionToolInput) => Promise<Record<string, unknown>> {
  return async (input) => {
    if (now() < cutoffAtMs) return {}
    const toolInput = input?.tool_input
    const filePath =
      toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
        ? (toolInput as Record<string, unknown>).file_path
        : undefined
    if (
      requiredOutputPath &&
      input?.tool_name === "Write" &&
      typeof filePath === "string" &&
      path.resolve(filePath) === path.resolve(requiredOutputPath)
    ) {
      return {}
    }
    return {
      decision: "block",
      reason:
        "The run has entered its reserved completion window. Do not call more tools. " +
        (requiredOutputPath ? `If the required structured result is missing, write only ${requiredOutputPath}. ` : "") +
        "Use the evidence and changes already present, state any verification limits clearly, and return your final response now.",
    }
  }
}
