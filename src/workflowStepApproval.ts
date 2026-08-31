import { createHash } from "node:crypto"
import type { WorkflowRunState } from "./implementations/types.js"

export function workflowStepApprovalContextHash(state: WorkflowRunState, stepId: string): string {
  const value = stableJson({
    stepId,
    definitionHash: state.definitionHash ?? null,
    input: state.input ?? {},
    facts: state.facts ?? {},
  })
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

export function requireWorkflowStepApproval(
  state: WorkflowRunState,
  stepId: string,
): WorkflowRunState & { approval: NonNullable<WorkflowRunState["approval"]> } {
  const contextHash = workflowStepApprovalContextHash(state, stepId)
  if (
    state.approval?.stepId === stepId &&
    state.approval.contextHash === contextHash &&
    state.approval.status === "approved"
  ) {
    return {
      ...state,
      status: "running",
      approval: { ...state.approval, status: "consumed" },
    }
  }
  return {
    ...state,
    status: "waiting-approval",
    approval: {
      stepId,
      action: `workflow-step:${stepId}`,
      contextHash,
      status: "pending",
    },
  }
}

export function approveWorkflowStep(
  state: WorkflowRunState,
  approval: {
    stepId: string
    contextHash: string
    approvedAt: string
    approvedBy: string
  },
): WorkflowRunState & { approval: NonNullable<WorkflowRunState["approval"]> } {
  if (
    state.status !== "waiting-approval" ||
    state.approval?.status !== "pending" ||
    state.approval.stepId !== approval.stepId ||
    state.approval.contextHash !== approval.contextHash
  ) {
    throw new Error("Workflow approval context changed; request a fresh approval")
  }
  return {
    ...state,
    status: "running",
    approval: {
      ...state.approval,
      status: "approved",
      approvedAt: approval.approvedAt,
      approvedBy: approval.approvedBy,
    },
  }
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
