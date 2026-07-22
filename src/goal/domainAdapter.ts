import {
  createGoalDefinition,
  createGoalState,
  createLoopDefinition,
  createLoopState,
  createWorkflowDefinition,
  type GoalDefinition,
  type GoalState as DomainGoalState,
  type LoopDefinition,
  type LoopState,
  type WorkflowDefinition,
} from "@kody-ade/agency-domain"
import type { GoalState } from "./state.js"

export type MigratedManagedWork =
  | { kind: "goal"; definition: GoalDefinition; state: DomainGoalState; workflow?: WorkflowDefinition }
  | { kind: "loop"; definition: LoopDefinition; state: LoopState }

export function migrateLegacyManagedWork(id: string, legacy: GoalState): MigratedManagedWork {
  const operationId = requiredString(legacy.extra.operationId, `Managed work "${id}" has no Operation`)
  const destination = record(legacy.extra.destination)
  const evidence = stringArray(destination.requiredEvidence ?? destination.evidence)
  const objective = {
    desiredState: requiredString(destination.desiredState ?? destination.outcome, `Managed work "${id}" has no desired state`),
    requiredEvidence: evidence,
    scope: record(legacy.extra.scope),
  }

  if (isLoop(legacy.extra)) {
    const target = record(legacy.extra.loopTarget)
    const targetKind = target.type
    if (targetKind !== "goal" && targetKind !== "workflow" && targetKind !== "capability") {
      throw new Error(`Loop "${id}" has no valid target`)
    }
    const failures = nonNegativeInteger(record(legacy.extra.scheduleState).failures)
    return {
      kind: "loop",
      definition: createLoopDefinition({
        id,
        operationId,
        objective,
        trigger: triggerFromSchedule(legacy.extra.schedule),
        targetRef: { kind: targetKind, id: requiredString(target.id, `Loop "${id}" has no target id`) },
        reconciliationPolicy: { overlap: "skip", missed: "coalesce" },
      }),
      state: createLoopState({
        definitionId: id,
        lifecycle: lifecycle(legacy.state),
        health: failures > 0 ? "degraded" : "unknown",
        failures,
        updatedAt: stateTimestamp(legacy),
      }),
    }
  }

  const route = arrayOfRecords(legacy.extra.route)
  const workflowRef = record(legacy.extra.workflowRef)
  let workflow: WorkflowDefinition | undefined
  let executionRef: { kind: "workflow" | "capability"; id: string }
  if (typeof workflowRef.id === "string" && workflowRef.id.trim()) {
    executionRef = { kind: "workflow", id: workflowRef.id.trim() }
  } else if (route.length > 0) {
    const workflowId = `${id}-workflow`
    workflow = createWorkflowDefinition({
      id: workflowId,
      steps: route.map((step, index) => ({
        id: domainId(step.stage, `step-${index + 1}`),
        capabilityRef: {
          kind: "capability",
          id: requiredString(step.capability ?? step.implementation, `Goal "${id}" route step has no Capability`),
        },
        dependsOn: index === 0 ? [] : [domainId(route[index - 1]!.stage, `step-${index}`)],
        ...(step.args && typeof step.args === "object" ? { input: step.args } : {}),
      })),
    })
    executionRef = { kind: "workflow", id: workflowId }
  } else {
    const capabilities = stringArray(legacy.extra.capabilities)
    if (capabilities.length !== 1) throw new Error(`Goal "${id}" requires one execution target`)
    executionRef = { kind: "capability", id: capabilities[0]! }
  }

  const facts = record(legacy.extra.facts)
  const completed = evidence.filter((key) => facts[key] === true).length
  return {
    kind: "goal",
    definition: createGoalDefinition({ id, operationId, objective, executionRef }),
    state: createGoalState({
      definitionId: id,
      lifecycle: lifecycle(legacy.state),
      progress: evidence.length === 0 ? 0 : completed / evidence.length,
      blockers: stringArray(legacy.extra.blockers),
      updatedAt: stateTimestamp(legacy),
    }),
    ...(workflow ? { workflow } : {}),
  }
}

function isLoop(value: Record<string, unknown>): boolean {
  return value.managedModel === "agentLoop" || value.scheduleMode === "agentLoop" || value.type === "agentLoop"
}

function triggerFromSchedule(value: unknown) {
  return typeof value === "string" && value !== "manual" && value.trim()
    ? ({ type: "schedule", every: value.trim() } as const)
    : ({ type: "manual" } as const)
}

function lifecycle(value: GoalState["state"]): "active" | "retired" | "archived" {
  if (value === "active") return "active"
  if (value === "abandoned") return "retired"
  return "archived"
}

function stateTimestamp(value: GoalState): string {
  return value.updatedAt ?? value.createdAt ?? value.startedAt ?? "1970-01-01T00:00:00.000Z"
}

function domainId(value: unknown, fallback: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-") : ""
  return normalized.replace(/^-+|-+$/g, "") || fallback
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message)
  return value.trim()
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : []
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : []
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
}
