import { createHash } from "node:crypto"
import type { CapabilityWorkflowConfig } from "./capabilityFolders.js"
import type { WorkflowRunState } from "./implementations/types.js"

export function workflowDefinitionHash(workflow: CapabilityWorkflowConfig): string {
  return createHash("sha256").update(stableJson(workflow)).digest("hex")
}

export function workflowResumeBlocker(
  state: WorkflowRunState | undefined,
  workflow: CapabilityWorkflowConfig,
): string | null {
  if (!state || state.status === "done") return null
  // Existing runs created before definition identities were introduced may
  // finish once. Every checkpoint written by the current runner includes the
  // hash, so subsequent resumes are protected without stranding old work.
  if (!state.definitionHash) return null
  if (state.definitionHash !== workflowDefinitionHash(workflow)) {
    return "The Workflow definition changed after this run started. Start a new run instead of resuming it."
  }
  return null
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}
