/**
 * Managed-goal todo state contract.
 *
 * This module owns the markdown-frontmatter and kody-todo-items-json mapping.
 * State repo transport stays in stateStore.ts.
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
  const frontmatter = parseFrontmatter(raw)
  const description = raw
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .replace(itemsBlockRe(), "")
    .trim()
  const items = parseItems(raw)
  const destination = recordField(frontmatter.destination)
  const evidence =
    stringArray(destination.evidence).length > 0
      ? stringArray(destination.evidence)
      : stringArray(frontmatter.evidence).length > 0
        ? stringArray(frontmatter.evidence)
        : items.map((item) => stringField(recordField(item.meta).evidence) || item.id).filter(Boolean)
  const facts = {
    ...recordField(frontmatter.facts),
    ...Object.fromEntries(
      items.map((item) => [stringField(recordField(item.meta).evidence) || item.id, item.completed]),
    ),
  }

  return parseGoalState(filePath, {
    ...frontmatter,
    id: goalId,
    state: frontmatter.state ?? "active",
    destination: {
      ...destination,
      outcome: description || stringField(destination.outcome),
      evidence,
    },
    capabilities:
      stringArray(frontmatter.capabilities).length > 0
        ? stringArray(frontmatter.capabilities)
        : items.map((item) => stringField(recordField(item.meta).capability)).filter(Boolean),
    route: Array.isArray(frontmatter.route) ? frontmatter.route : routeFromItems(items),
    facts,
    blockers: stringArray(frontmatter.blockers),
  })
}

export function isManagedTodoRaw(raw: string): boolean {
  return isManagedTodoFrontmatter(parseFrontmatter(raw))
}

export function serializeTodoGoalState(goalId: string, state: GoalState, previousRaw?: string): string {
  const raw = JSON.parse(serializeGoalState(state)) as Record<string, unknown>
  const destination = recordField(raw.destination)
  const outcome = stringField(destination.outcome)
  const evidence = stringArray(destination.evidence)
  const route = Array.isArray(raw.route) ? (raw.route as Record<string, unknown>[]) : []
  const facts = recordField(raw.facts)
  const now = new Date().toISOString()
  const createdAt = stringField(raw.createdAt) || stringField(raw.startedAt) || now
  const routeByEvidence = new Map(route.map((step) => [stringField(step.evidence), step] as const))
  const previousItems = new Map(parseItems(previousRaw ?? "").map((item) => [item.id, item] as const))
  const items =
    evidence.length > 0
      ? evidence.map((key) =>
          itemFromEvidence(key, routeByEvidence.get(key), facts, createdAt, now, previousItems.get(key)),
        )
      : stringArray(raw.capabilities).map((capability) =>
          itemFromCapability(capability, createdAt, previousItems.get(capability)),
        )

  delete raw.destination
  raw.id = goalId
  raw.title = goalId
  raw.createdAt = createdAt
  raw.managed = true
  raw.managedModel = raw.scheduleMode === "agentLoop" || raw.type === "agentLoop" ? "agentLoop" : "agentGoal"
  raw.evidence = evidence

  return [
    "---",
    ...Object.entries(raw)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${serializeFrontmatterValue(value)}`),
    "---",
    "",
    outcome,
    "",
    "<!-- kody-todo-items-json",
    JSON.stringify(items, null, 2),
    "-->",
    "",
  ].join("\n")
}

function isManagedTodoFrontmatter(frontmatter: Record<string, unknown>): boolean {
  return (
    frontmatter.managed === true ||
    frontmatter.managed === "true" ||
    frontmatter.managedModel === "agentGoal" ||
    frontmatter.managedModel === "agentLoop"
  )
}

function itemFromEvidence(
  evidence: string,
  step: Record<string, unknown> | undefined,
  facts: Record<string, unknown>,
  createdAt: string,
  now: string,
  prior?: TodoItemState,
): TodoItemState {
  const completed = facts[evidence] === true
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
      ...(step
        ? {
            stage: stringField(step.stage),
            capability: stringField(step.capability),
            ...(step.args && typeof step.args === "object" ? { args: step.args } : {}),
            ...(step.saveReport === true ? { saveReport: true } : {}),
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
      },
    ]
  })
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!match) return {}
  const parsed: Record<string, unknown> = {}
  for (const rawLine of (match[1] ?? "").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const colon = line.indexOf(":")
    if (colon === -1) continue
    parsed[line.slice(0, colon).trim()] = parseFrontmatterValue(line.slice(colon + 1).trim())
  }
  return parsed
}

function parseFrontmatterValue(raw: string): unknown {
  let value = raw
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  if (value === "true") return true
  if (value === "false") return false
  if (value === "null") return null
  if (value.startsWith("{") || value.startsWith("[") || /^-?\d+(\.\d+)?$/.test(value)) {
    try {
      return JSON.parse(value)
    } catch {}
  }
  return value
}

function serializeFrontmatterValue(value: unknown): string {
  if (typeof value === "string") return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  return `"${JSON.stringify(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function itemsBlockRe(): RegExp {
  return /<!--\s*kody-todo-items-json\s*\r?\n([\s\S]*?)\r?\n-->/
}

function parseItems(raw: string): TodoItemState[] {
  const match = itemsBlockRe().exec(raw)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[1] ?? "[]") as unknown
    return Array.isArray(parsed) ? (parsed.filter((item) => item && typeof item === "object") as TodoItemState[]) : []
  } catch {
    return []
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
