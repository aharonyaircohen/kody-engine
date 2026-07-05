import type { GoalState } from "./state.js"
import { parseGoalEvidenceState, type GoalEvidenceState, type GoalEvidenceResultClass } from "./evidenceState.js"

export const SIMPLE_GOAL_TYPE = "simple"
export const SIMPLE_GOAL_EVIDENCE = "labelledTasksComplete"

export interface GoalDestination {
  outcome: string
  evidence: string[]
}

export interface GoalRouteStep {
  evidence: string
  stage: string
  capability: string
  executable?: string
  args?: Record<string, unknown>
  saveReport?: boolean
  onPending?: GoalRoutePolicy
  onFailure?: GoalRoutePolicy
}

export type GoalRoutePolicyAction = "wait" | "retry" | "block" | "issue"

export interface GoalRoutePolicy {
  action: GoalRoutePolicyAction
  maxAttempts?: number
  retryAfterSeconds?: number
}

export interface ManagedLoopTarget {
  type: "goal" | "capability" | "workflow"
  id: string
}

export interface ManagedGoalPreferredRunTime {
  time: string
  timezone: string
}

export interface ManagedGoal {
  type: string
  destination: GoalDestination
  capabilities: string[]
  route: GoalRouteStep[]
  schedule?: string
  preferredRunTime?: ManagedGoalPreferredRunTime
  loopTarget?: ManagedLoopTarget
  stage?: string
  facts: Record<string, unknown>
  blockers: string[]
  evidenceState?: GoalEvidenceState
  reason?: string
  nextAction?: string
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
      capability: string
      executable?: string
      cliArgs: Record<string, unknown>
      saveReport?: boolean
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
    Array.isArray(goal.capabilities) &&
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
    goal.reason = "destination evidence satisfied"
    goal.nextAction = "done"
    return { kind: "done" }
  }

  const step = goal.route.find((candidate) => candidate.evidence === missing)
  if (!step) {
    if (isSimpleGoal(goal) && missing === SIMPLE_GOAL_EVIDENCE) {
      goal.stage = "waiting"
      delete goal.facts.pendingEvidence
      const total = typeof goal.facts.simpleAttachedTaskCount === "number" ? goal.facts.simpleAttachedTaskCount : 0
      const open = typeof goal.facts.simpleOpenTaskCount === "number" ? goal.facts.simpleOpenTaskCount : 0
      goal.reason = total === 0 ? "waiting for labelled tasks" : `waiting for ${open} open labelled task(s)`
      goal.nextAction = "wait"
      return {
        kind: "wait",
        evidence: missing,
        stage: "waiting",
        reason: goal.reason,
      }
    }
    const reason = `no route step for evidence: ${missing}`
    goal.stage = "blocked"
    goal.reason = reason
    goal.nextAction = "fix route"
    pushBlocker(goal, reason)
    return { kind: "blocked", evidence: missing, stage: "blocked", reason }
  }

  const progressDecision = decisionFromEvidenceProgress(goal, step, missing)
  if (progressDecision) return progressDecision

  if (!goal.capabilities.includes(step.capability)) {
    const reason = `route capability ${step.capability} is not attached to this goal`
    goal.stage = "blocked"
    goal.reason = reason
    goal.nextAction = "attach capability"
    pushBlocker(goal, reason)
    return { kind: "blocked", evidence: missing, stage: step.stage, reason }
  }

  const resolved = resolveRouteArgs(goal, step)
  if (!resolved.ok) {
    goal.stage = "blocked"
    goal.reason = resolved.reason
    goal.nextAction = "fix route args"
    pushBlocker(goal, resolved.reason)
    return { kind: "blocked", evidence: missing, stage: step.stage, reason: resolved.reason }
  }

  goal.stage = step.stage
  goal.facts.pendingEvidence = missing
  goal.reason = `dispatch ${step.capability} for ${missing}`
  goal.nextAction = "dispatch"
  return {
    kind: "dispatch",
    evidence: missing,
    stage: step.stage,
    capability: step.capability,
    executable: step.executable,
    cliArgs: resolved.cliArgs,
    ...(step.saveReport === true ? { saveReport: true } : {}),
  }
}

function decisionFromEvidenceProgress(
  goal: ManagedGoal,
  step: GoalRouteStep,
  evidence: string,
): ManagedGoalDecision | null {
  const progress = goal.evidenceState?.[evidence]
  if (!progress) return null

  if (progress.resultClass === "pending") {
    const policy = step.onPending ?? { action: "wait" as const }
    if (policy.action === "retry") return null
    if (policy.action === "block" || policy.action === "issue") {
      const reason = progress.reason ?? `waiting for ${evidence}`
      goal.stage = "blocked"
      goal.reason = reason
      goal.nextAction = policy.action === "issue" ? "create issue" : "block"
      pushBlocker(goal, reason)
      return { kind: "blocked", evidence, stage: step.stage, reason }
    }
    const reason = progress.reason ?? `waiting for ${evidence}`
    goal.stage = step.stage
    goal.reason = reason
    goal.nextAction = progress.nextAction ?? "wait"
    return { kind: "wait", evidence, stage: step.stage, reason }
  }

  if (progress.resultClass === "retryable") {
    const policy = step.onFailure ?? { action: "retry" as const }
    if (policy.action === "block" || policy.action === "issue") {
      const reason = progress.reason ?? `retryable failure for ${evidence}`
      goal.stage = "blocked"
      goal.reason = reason
      goal.nextAction = policy.action === "issue" ? "create issue" : "block"
      pushBlocker(goal, reason)
      return { kind: "blocked", evidence, stage: step.stage, reason }
    }
    if (policy.action === "wait") {
      const reason = progress.reason ?? `waiting to retry ${evidence}`
      goal.stage = step.stage
      goal.reason = reason
      goal.nextAction = progress.nextRetryAt ? `retry after ${progress.nextRetryAt}` : "wait"
      return { kind: "wait", evidence, stage: step.stage, reason }
    }
    if (policy.maxAttempts !== undefined && progress.attempts >= policy.maxAttempts) {
      const reason = `retry limit reached for ${evidence}`
      goal.stage = "blocked"
      goal.reason = reason
      goal.nextAction = "create issue"
      pushBlocker(goal, reason)
      return { kind: "blocked", evidence, stage: step.stage, reason }
    }
    if (progress.nextRetryAt && Date.parse(progress.nextRetryAt) > Date.now()) {
      const reason = progress.reason ?? `retry ${evidence} after ${progress.nextRetryAt}`
      goal.stage = step.stage
      goal.reason = reason
      goal.nextAction = `retry after ${progress.nextRetryAt}`
      return { kind: "wait", evidence, stage: step.stage, reason }
    }
    return null
  }

  if (progress.resultClass === "needsFix" || progress.resultClass === "fatal") {
    const policy = step.onFailure ?? defaultFailurePolicy(progress.resultClass)
    if (policy.action === "retry") return null
    const reason = progress.reason ?? `${resultClassLabel(progress.resultClass)} for ${evidence}`
    goal.stage = "blocked"
    goal.reason = reason
    goal.nextAction = progress.issue ? `fix issue #${progress.issue}` : policy.action === "issue" ? "create issue" : "block"
    pushBlocker(goal, reason)
    return { kind: "blocked", evidence, stage: step.stage, reason }
  }

  return null
}

function defaultFailurePolicy(resultClass: GoalEvidenceResultClass): GoalRoutePolicy {
  return resultClass === "needsFix" ? { action: "issue" } : { action: "block" }
}

function resultClassLabel(resultClass: GoalEvidenceResultClass): string {
  if (resultClass === "needsFix") return "needs fix"
  return resultClass
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
    if (typeof raw.evidence !== "string" || typeof raw.stage !== "string" || typeof raw.capability !== "string") {
      return null
    }
    const args = raw.args === undefined ? undefined : asRecord(raw.args)
    if (raw.args !== undefined && !args) return null
    route.push({
      evidence: raw.evidence,
      stage: raw.stage,
      capability: raw.capability,
      executable: typeof raw.executable === "string" ? raw.executable : undefined,
      args: args ?? undefined,
      saveReport: raw.saveReport === true,
      onPending: asRoutePolicy(raw.onPending),
      onFailure: asRoutePolicy(raw.onFailure),
    })
  }
  return route
}

function asRoutePolicy(value: unknown): GoalRoutePolicy | undefined {
  if (typeof value === "string") {
    return isRoutePolicyAction(value) ? { action: value } : undefined
  }
  const raw = asRecord(value)
  if (!raw || !isRoutePolicyAction(raw.action)) return undefined
  const maxAttempts =
    typeof raw.maxAttempts === "number" && Number.isInteger(raw.maxAttempts) && raw.maxAttempts > 0
      ? raw.maxAttempts
      : undefined
  const retryAfterSeconds =
    typeof raw.retryAfterSeconds === "number" && raw.retryAfterSeconds >= 0
      ? Math.floor(raw.retryAfterSeconds)
      : undefined
  return {
    action: raw.action,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  }
}

function isRoutePolicyAction(value: unknown): value is GoalRoutePolicyAction {
  return value === "wait" || value === "retry" || value === "block" || value === "issue"
}

function asPreferredRunTime(value: unknown): ManagedGoalPreferredRunTime | undefined {
  const raw = asRecord(value)
  if (!raw) return undefined
  if (typeof raw.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time)) return undefined
  if (typeof raw.timezone !== "string" || raw.timezone.trim().length === 0) return undefined
  return { time: raw.time, timezone: raw.timezone }
}

function asLoopTarget(value: unknown): ManagedLoopTarget | undefined {
  const raw = asRecord(value)
  if (!raw) return undefined
  if (raw.type !== "goal" && raw.type !== "capability" && raw.type !== "workflow") return undefined
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) return undefined
  return { type: raw.type, id: raw.id }
}

export function managedGoalFromState(state: GoalState): ManagedGoal | null {
  const extra = state.extra
  const destination = asRecord(extra.destination)
  const evidence = asStringArray(destination?.evidence)
  const capabilities = asStringArray(extra.capabilities)
  const route = asRoute(extra.route)
  const facts = asRecord(extra.facts)
  const blockers = asStringArray(extra.blockers)

  if (
    typeof extra.type !== "string" ||
    !destination ||
    typeof destination.outcome !== "string" ||
    !evidence ||
    !capabilities ||
    !route ||
    !facts ||
    !blockers
  ) {
    return null
  }

  return {
    type: extra.type,
    destination: { outcome: destination.outcome, evidence },
    capabilities,
    route,
    schedule: typeof extra.schedule === "string" ? extra.schedule : undefined,
    preferredRunTime: asPreferredRunTime(extra.preferredRunTime),
    loopTarget: asLoopTarget(extra.loopTarget),
    stage: typeof extra.stage === "string" ? extra.stage : undefined,
    facts,
    blockers,
    evidenceState: parseGoalEvidenceState(extra.evidenceState),
    reason: typeof extra.reason === "string" ? extra.reason : undefined,
    nextAction: typeof extra.nextAction === "string" ? extra.nextAction : undefined,
  }
}

export function writeManagedGoalToState(state: GoalState, goal: ManagedGoal): GoalState {
  return {
    ...state,
    extra: {
      ...state.extra,
      type: goal.type,
      destination: goal.destination,
      capabilities: goal.capabilities,
      route: goal.route,
      stage: goal.stage,
      facts: goal.facts,
      blockers: goal.blockers,
      evidenceState: goal.evidenceState ?? {},
      reason: goal.reason,
      nextAction: goal.nextAction,
    },
  }
}
