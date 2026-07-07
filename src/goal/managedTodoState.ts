/**
 * Managed-goal todo state contract.
 *
 * This module owns the JSON todo mapping. State repo transport stays in
 * stateStore.ts.
 */
import { type GoalState, parseGoalState, serializeGoalState } from "./state.js"

export interface TodoItemState {
  id: string
  title: string
  body: string
  assignee: string | null
  completed: boolean
  createdAt: string
  completedAt: string | null
  meta?: Record<string, unknown>
}

export function parseTodoGoalState(goalId: string, filePath: string, raw: string): GoalState {
  const data = parseJsonRecord(raw) ?? {}
  const items = normalizeItems(data.items)
  const destination = recordField(data.destination)
  const evidence =
    stringArray(destination.evidence).length > 0
      ? stringArray(destination.evidence)
      : stringArray(data.evidence).length > 0
        ? stringArray(data.evidence)
        : items.map((item) => stringField(recordField(item.meta).evidence) || item.id).filter(Boolean)
  const facts = {
    ...recordField(data.facts),
    ...Object.fromEntries(
      items.map((item) => [stringField(recordField(item.meta).evidence) || item.id, item.completed]),
    ),
  }
  const route = Array.isArray(data.route) ? (data.route as Record<string, unknown>[]) : routeFromItems(items)

  return parseGoalState(filePath, {
    ...data,
    id: goalId,
    version: data.version ?? 1,
    state: data.state ?? "active",
    type: data.type ?? "general",
    destination: {
      ...destination,
      outcome: stringField(data.description) || stringField(destination.outcome),
      evidence,
    },
    capabilities:
      stringArray(data.capabilities).length > 0
        ? stringArray(data.capabilities)
        : route.map((step) => stringField(step.capability)).filter(Boolean),
    route,
    facts,
    blockers: stringArray(data.blockers),
  })
}

export function isManagedTodoRaw(raw: string): boolean {
  return isManagedTodoRecord(parseJsonRecord(raw) ?? {})
}

export function serializeTodoGoalState(goalId: string, state: GoalState, previousRaw?: string): string {
  const raw = JSON.parse(serializeGoalState(state)) as Record<string, unknown>
  const destination = recordField(raw.destination)
  const outcome = stringField(raw.description) || stringField(destination.outcome)
  const evidence =
    stringArray(destination.evidence).length > 0 ? stringArray(destination.evidence) : stringArray(raw.evidence)
  const route = Array.isArray(raw.route) ? (raw.route as Record<string, unknown>[]) : []
  const facts = recordField(raw.facts)
  const evidenceState = recordField(raw.evidenceState)
  const now = new Date().toISOString()
  const createdAt = stringField(raw.createdAt) || stringField(raw.startedAt) || now
  const routeByEvidence = new Map(route.map((step) => [stringField(step.evidence), step] as const))
  const previousItems = new Map(parseItemsFromAnyRaw(previousRaw ?? "").map((item) => [item.id, item] as const))
  const items =
    evidence.length > 0
      ? evidence.map((key) =>
          itemFromEvidence(key, routeByEvidence.get(key), facts, evidenceState, createdAt, now, previousItems.get(key)),
        )
      : stringArray(raw.capabilities).map((capability) =>
          itemFromCapability(capability, createdAt, previousItems.get(capability)),
        )

  return `${JSON.stringify(
    {
      version: 1,
      ...raw,
      id: goalId,
      title: goalId,
      description: outcome,
      createdAt,
      managed: true,
      managedModel: raw.scheduleMode === "agentLoop" || raw.type === "agentLoop" ? "agentLoop" : "agentGoal",
      evidence,
      items,
    },
    null,
    2,
  )}\n`
}

function isManagedTodoRecord(record: Record<string, unknown>): boolean {
  return (
    record.managed === true ||
    record.managed === "true" ||
    record.managedModel === "agentGoal" ||
    record.managedModel === "agentLoop"
  )
}

function itemFromEvidence(
  evidence: string,
  step: Record<string, unknown> | undefined,
  facts: Record<string, unknown>,
  evidenceState: Record<string, unknown>,
  createdAt: string,
  now: string,
  prior?: TodoItemState,
): TodoItemState {
  const completed = facts[evidence] === true
  const progress = recordField(evidenceState[evidence])
  return {
    id: evidence,
    title: (prior?.title ?? stringField(step?.stage)) || evidence,
    body: prior?.body ?? "",
    assignee: prior?.assignee ?? null,
    completed,
    createdAt: prior?.createdAt ?? createdAt,
    completedAt: completed ? (prior?.completedAt ?? now) : null,
    meta: {
      ...(prior?.meta ?? {}),
      evidence,
      ...(stringField(progress?.resultClass) ? { resultClass: stringField(progress?.resultClass) } : {}),
      ...(typeof progress?.attempts === "number" ? { attempts: progress.attempts } : {}),
      ...(stringField(progress?.reason) ? { reason: stringField(progress?.reason) } : {}),
      ...(stringField(progress?.nextAction) ? { nextAction: stringField(progress?.nextAction) } : {}),
      ...(stringField(progress?.nextRetryAt) ? { nextRetryAt: stringField(progress?.nextRetryAt) } : {}),
      ...(typeof progress?.issue === "number" ? { issue: progress.issue } : {}),
      ...(step
        ? {
            stage: stringField(step.stage),
            capability: stringField(step.capability),
            ...(step.args && typeof step.args === "object" ? { args: step.args } : {}),
            ...(step.saveReport === true ? { saveReport: true } : {}),
            ...(step.onPending && typeof step.onPending === "object" ? { onPending: step.onPending } : {}),
            ...(step.onFailure && typeof step.onFailure === "object" ? { onFailure: step.onFailure } : {}),
          }
        : {}),
    },
  }
}

function itemFromCapability(capability: string, createdAt: string, prior?: TodoItemState): TodoItemState {
  return {
    id: capability,
    title: prior?.title ?? capability,
    body: prior?.body ?? "",
    assignee: prior?.assignee ?? null,
    completed: prior?.completed ?? false,
    createdAt: prior?.createdAt ?? createdAt,
    completedAt: prior?.completedAt ?? null,
    meta: { ...(prior?.meta ?? {}), capability },
  }
}

function routeFromItems(items: TodoItemState[]): Record<string, unknown>[] {
  return items.flatMap((item) => {
    const meta = recordField(item.meta)
    const evidence = stringField(meta.evidence) || item.id
    const stage = stringField(meta.stage)
    const capability = stringField(meta.capability)
    if (!evidence || !stage || !capability) return []
    return [
      {
        evidence,
        stage,
        capability,
        ...(meta.args ? { args: meta.args } : {}),
        ...(meta.saveReport === true ? { saveReport: true } : {}),
        ...(meta.onPending ? { onPending: meta.onPending } : {}),
        ...(meta.onFailure ? { onFailure: meta.onFailure } : {}),
      },
    ]
  })
}

function parseItemsFromAnyRaw(raw: string): TodoItemState[] {
  const json = parseJsonRecord(raw)
  return json ? normalizeItems(json.items) : []
}

function normalizeItems(value: unknown): TodoItemState[] {
  return Array.isArray(value) ? (value.filter((item) => item && typeof item === "object") as TodoItemState[]) : []
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return recordField(parsed)
  } catch {
    return null
  }
}

function recordField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}
