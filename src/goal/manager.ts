import type { GoalState } from "./state.js"

export const SIMPLE_GOAL_TYPE = "simple"
export const SIMPLE_GOAL_EVIDENCE = "labelledTasksComplete"

export interface GoalDestination {
  outcome: string
  evidence: string[]
}

export interface GoalRouteStep {
  evidence: string
  stage: string
  duty: string
  executable?: string
  args?: Record<string, unknown>
}

export interface ManagedGoal {
  type: string
  destination: GoalDestination
  duties: string[]
  route: GoalRouteStep[]
  stage?: string
  facts: Record<string, unknown>
  blockers: string[]
}

export interface SimpleGoalTaskSummary {
  total: number
  open: number
}

export type ManagedGoalDecision =
  | {
      kind: "dispatch"
      evidence: string
      stage: string
      duty: string
      executable?: string
      cliArgs: Record<string, unknown>
    }
  | { kind: "wait"; evidence: string; stage: string; reason: string }
  | { kind: "blocked"; evidence: string; stage: string; reason: string }
  | { kind: "done" }
  | { kind: "idle"; reason: string }

function evidenceSatisfied(goal: ManagedGoal, evidence: string): boolean {
  return goal.facts[evidence] === true
}

function firstMissingEvidence(goal: ManagedGoal): string | undefined {
  return goal.destination.evidence.find((evidence) => !evidenceSatisfied(goal, evidence))
}

function pushBlocker(goal: ManagedGoal, reason: string): void {
  if (!goal.blockers.includes(reason)) goal.blockers.push(reason)
}

export function isSimpleGoal(goal: ManagedGoal): boolean {
  return goal.type === SIMPLE_GOAL_TYPE
}

export function applySimpleGoalTaskSummary(goal: ManagedGoal, summary: SimpleGoalTaskSummary): void {
  goal.facts.simpleAttachedTaskCount = summary.total
  goal.facts.simpleOpenTaskCount = summary.open
  goal.facts[SIMPLE_GOAL_EVIDENCE] = summary.total > 0 && summary.open === 0
}

function isFactReference(value: unknown): value is { fact: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 1 && typeof record.fact === "string" && record.fact.length > 0
}

function isCliArgValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

function resolveRouteArgs(
  goal: ManagedGoal,
  step: GoalRouteStep,
): { ok: true; cliArgs: Record<string, unknown> } | { ok: false; reason: string } {
  const cliArgs: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(step.args ?? {})) {
    if (!isFactReference(value)) {
      cliArgs[name] = value
      continue
    }

    const factValue = goal.facts[value.fact]
    if (factValue === undefined || factValue === null) {
      return { ok: false, reason: `route arg ${name} needs missing fact ${value.fact}` }
    }
    if (!isCliArgValue(factValue)) {
      return { ok: false, reason: `route arg ${name} needs scalar fact ${value.fact}` }
    }
    cliArgs[name] = factValue
  }
  return { ok: true, cliArgs }
}

export function isManagedGoal(value: unknown): value is ManagedGoal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const goal = value as Partial<ManagedGoal>
  return (
    typeof goal.type === "string" &&
    !!goal.destination &&
    typeof goal.destination === "object" &&
    Array.isArray((goal.destination as Partial<GoalDestination>).evidence) &&
    Array.isArray(goal.duties) &&
    Array.isArray(goal.route) &&
    !!goal.facts &&
    typeof goal.facts === "object" &&
    !Array.isArray(goal.facts) &&
    Array.isArray(goal.blockers)
  )
}

export function planManagedGoalTick(goal: ManagedGoal): ManagedGoalDecision {
  goal.blockers = []

  const missing = firstMissingEvidence(goal)
  if (!missing) {
    goal.stage = "done"
    delete goal.facts.pendingEvidence
    return { kind: "done" }
  }

  const pending = goal.facts.pendingEvidence
  if (pending === missing) {
    const stage = typeof goal.stage === "string" ? goal.stage : "waiting"
    return { kind: "wait", evidence: missing, stage, reason: `waiting for evidence: ${missing}` }
  }

  const step = goal.route.find((candidate) => candidate.evidence === missing)
  if (!step) {
    if (isSimpleGoal(goal) && missing === SIMPLE_GOAL_EVIDENCE) {
      goal.stage = "waiting"
      delete goal.facts.pendingEvidence
      const total = typeof goal.facts.simpleAttachedTaskCount === "number" ? goal.facts.simpleAttachedTaskCount : 0
      const open = typeof goal.facts.simpleOpenTaskCount === "number" ? goal.facts.simpleOpenTaskCount : 0
      return {
        kind: "wait",
        evidence: missing,
        stage: "waiting",
        reason: total === 0 ? "waiting for labelled tasks" : `waiting for ${open} open labelled task(s)`,
      }
    }
    const reason = `no route step for evidence: ${missing}`
    goal.stage = "blocked"
    pushBlocker(goal, reason)
    return { kind: "blocked", evidence: missing, stage: "blocked", reason }
  }

  if (!goal.duties.includes(step.duty)) {
    const reason = `route duty ${step.duty} is not attached to this goal`
    goal.stage = "blocked"
    pushBlocker(goal, reason)
    return { kind: "blocked", evidence: missing, stage: step.stage, reason }
  }

  const resolved = resolveRouteArgs(goal, step)
  if (!resolved.ok) {
    goal.stage = "blocked"
    pushBlocker(goal, resolved.reason)
    return { kind: "blocked", evidence: missing, stage: step.stage, reason: resolved.reason }
  }

  goal.stage = step.stage
  goal.facts.pendingEvidence = missing
  return {
    kind: "dispatch",
    evidence: missing,
    stage: step.stage,
    duty: step.duty,
    executable: step.executable,
    cliArgs: resolved.cliArgs,
  }
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null
  return [...value]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return { ...(value as Record<string, unknown>) }
}

function asRoute(value: unknown): GoalRouteStep[] | null {
  if (!Array.isArray(value)) return null
  const route: GoalRouteStep[] = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null
    const raw = item as Record<string, unknown>
    if (typeof raw.evidence !== "string" || typeof raw.stage !== "string" || typeof raw.duty !== "string") {
      return null
    }
    const args = raw.args === undefined ? undefined : asRecord(raw.args)
    if (raw.args !== undefined && !args) return null
    route.push({
      evidence: raw.evidence,
      stage: raw.stage,
      duty: raw.duty,
      executable: typeof raw.executable === "string" ? raw.executable : undefined,
      args: args ?? undefined,
    })
  }
  return route
}

export function managedGoalFromState(state: GoalState): ManagedGoal | null {
  const extra = state.extra
  const destination = asRecord(extra.destination)
  const evidence = asStringArray(destination?.evidence)
  const duties = asStringArray(extra.duties)
  const route = asRoute(extra.route)
  const facts = asRecord(extra.facts)
  const blockers = asStringArray(extra.blockers)

  if (
    typeof extra.type !== "string" ||
    !destination ||
    typeof destination.outcome !== "string" ||
    !evidence ||
    !duties ||
    !route ||
    !facts ||
    !blockers
  ) {
    return null
  }

  return {
    type: extra.type,
    destination: { outcome: destination.outcome, evidence },
    duties,
    route,
    stage: typeof extra.stage === "string" ? extra.stage : undefined,
    facts,
    blockers,
  }
}

export function writeManagedGoalToState(state: GoalState, goal: ManagedGoal): GoalState {
  return {
    ...state,
    extra: {
      ...state.extra,
      type: goal.type,
      destination: goal.destination,
      duties: goal.duties,
      route: goal.route,
      stage: goal.stage,
      facts: goal.facts,
      blockers: goal.blockers,
    },
  }
}
