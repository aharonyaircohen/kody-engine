import { type GoalState, nowIso } from "./goal/state.js"

export interface CompanyManagerDecision {
  summary: string
  actions: CompanyManagerAction[]
}

export type CompanyManagerAction =
  | CreateManagedGoalAction
  | CreateAgentLoopAction
  | SetGoalLifecycleAction
  | UpdateIntentPortfolioAction
  | DecisionNoteAction

export interface CreateManagedGoalAction {
  kind: "createManagedGoal"
  intentId: string
  id: string
  outcome: string
  goalType?: string
  evidence: string[]
  capabilities: string[]
  route: Array<{
    stage: string
    evidence: string
    capability: string
    executable?: string
    args?: Record<string, unknown>
  }>
  facts?: Record<string, unknown>
  reason: string
}

export interface CreateAgentLoopAction {
  kind: "createAgentLoop"
  intentId: string
  id: string
  outcome: string
  every: "manual" | "1h" | "1d" | "7d" | "30d"
  capabilities: string[]
  reason: string
}

export interface SetGoalLifecycleAction {
  kind: "setGoalLifecycle"
  intentId: string
  id: string
  state: "active" | "closed" | "abandoned"
  reason: string
}

export interface UpdateIntentPortfolioAction {
  kind: "updateIntentPortfolio"
  intentId: string
  goals?: string[]
  loops?: string[]
  capabilities?: string[]
  reason: string
}

export interface DecisionNoteAction {
  kind: "note"
  intentId?: string
  message: string
}

const SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/

export function parseCompanyManagerDecisionText(finalText: string): CompanyManagerDecision {
  const raw = extractDecisionJson(finalText)
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("company-manager decision must be JSON object")
  }
  const input = parsed as Record<string, unknown>
  const actions = Array.isArray(input.actions) ? input.actions.map(parseAction) : []
  return {
    summary: typeof input.summary === "string" ? input.summary.trim() : "",
    actions,
  }
}

export function buildManagedGoalState(action: CreateManagedGoalAction): GoalState {
  const at = nowIso()
  return {
    state: "active",
    createdAt: at,
    updatedAt: at,
    extra: {
      type: action.goalType ?? "release",
      destination: { outcome: action.outcome, evidence: action.evidence },
      capabilities: action.capabilities,
      route: action.route,
      facts: action.facts ?? {},
      blockers: [],
      createdByIntent: action.intentId,
      manager: "cto",
    },
  }
}

export function buildAgentLoopState(action: CreateAgentLoopAction): GoalState {
  const at = nowIso()
  return {
    state: "active",
    createdAt: at,
    updatedAt: at,
    extra: {
      type: "agentLoop",
      scheduleMode: "agentLoop",
      schedule: action.every,
      destination: { outcome: action.outcome, evidence: [] },
      capabilities: action.capabilities,
      route: [],
      facts: {},
      blockers: [],
      createdByIntent: action.intentId,
      manager: "cto",
    },
  }
}

function extractDecisionJson(finalText: string): string {
  const fence = finalText.match(/```(?:kody-company-manager-decision|json)\s*([\s\S]*?)```/i)
  if (fence?.[1]) return fence[1].trim()
  const line = finalText.match(/KODY_COMPANY_MANAGER_DECISION=(\{[\s\S]*\})/)
  if (line?.[1]) return line[1].trim()
  throw new Error("missing kody-company-manager-decision JSON")
}

function parseAction(value: unknown): CompanyManagerAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("company-manager action must be object")
  }
  const input = value as Record<string, unknown>
  const kind = input.kind
  if (kind === "createManagedGoal") return parseCreateManagedGoal(input)
  if (kind === "createAgentLoop") return parseCreateAgentLoop(input)
  if (kind === "setGoalLifecycle") return parseSetGoalLifecycle(input)
  if (kind === "updateIntentPortfolio") return parseUpdateIntentPortfolio(input)
  if (kind === "note") return parseNote(input)
  throw new Error(`unsupported company-manager action kind: ${String(kind)}`)
}

function parseCreateManagedGoal(input: Record<string, unknown>): CreateManagedGoalAction {
  const route = Array.isArray(input.route) ? input.route.map(parseRouteStep) : []
  if (route.length === 0) throw new Error("createManagedGoal requires route")
  const evidence = stringArray(input.evidence)
  if (evidence.length === 0) throw new Error("createManagedGoal requires evidence")
  return {
    kind: "createManagedGoal",
    intentId: slug(input.intentId, "intentId"),
    id: slug(input.id, "id"),
    outcome: requiredString(input.outcome, "outcome"),
    goalType: typeof input.goalType === "string" && input.goalType.trim() ? input.goalType.trim() : undefined,
    evidence,
    capabilities: nonEmptyStringArray(input.capabilities, "capabilities"),
    route,
    facts: record(input.facts) ?? {},
    reason: requiredString(input.reason, "reason"),
  }
}

function parseCreateAgentLoop(input: Record<string, unknown>): CreateAgentLoopAction {
  return {
    kind: "createAgentLoop",
    intentId: slug(input.intentId, "intentId"),
    id: slug(input.id, "id"),
    outcome: requiredString(input.outcome, "outcome"),
    every: oneOf(input.every, ["manual", "1h", "1d", "7d", "30d"] as const, "1d"),
    capabilities: nonEmptyStringArray(input.capabilities, "capabilities"),
    reason: requiredString(input.reason, "reason"),
  }
}

function parseSetGoalLifecycle(input: Record<string, unknown>): SetGoalLifecycleAction {
  return {
    kind: "setGoalLifecycle",
    intentId: slug(input.intentId, "intentId"),
    id: slug(input.id, "id"),
    state: oneOf(input.state, ["active", "closed", "abandoned"] as const, "active"),
    reason: requiredString(input.reason, "reason"),
  }
}

function parseUpdateIntentPortfolio(input: Record<string, unknown>): UpdateIntentPortfolioAction {
  return {
    kind: "updateIntentPortfolio",
    intentId: slug(input.intentId, "intentId"),
    goals: stringArray(input.goals).filter(isSlug),
    loops: stringArray(input.loops).filter(isSlug),
    capabilities: stringArray(input.capabilities).filter(isSlug),
    reason: requiredString(input.reason, "reason"),
  }
}

function parseNote(input: Record<string, unknown>): DecisionNoteAction {
  return {
    kind: "note",
    intentId: typeof input.intentId === "string" && isSlug(input.intentId) ? input.intentId : undefined,
    message: requiredString(input.message ?? input.content, "message"),
  }
}

function parseRouteStep(value: unknown): CreateManagedGoalAction["route"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("route step must be object")
  const input = value as Record<string, unknown>
  return {
    stage: requiredString(input.stage, "route.stage"),
    evidence: requiredString(input.evidence, "route.evidence"),
    capability: slug(input.capability, "route.capability"),
    ...(typeof input.executable === "string" && input.executable.trim() ? { executable: input.executable.trim() } : {}),
    ...(record(input.args) ? { args: record(input.args)! } : {}),
  }
}

function slug(value: unknown, field: string): string {
  const text = requiredString(value, field)
  if (!isSlug(text)) throw new Error(`${field} must be lowercase slug`)
  return text
}

function isSlug(value: string): boolean {
  return SLUG_RE.test(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
}

function nonEmptyStringArray(value: unknown, field: string): string[] {
  const values = stringArray(value)
  if (values.length === 0) throw new Error(`${field} must not be empty`)
  return values
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : null
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T[number]) : fallback
}
