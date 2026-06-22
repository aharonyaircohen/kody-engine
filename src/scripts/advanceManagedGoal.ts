import type { PreflightScript } from "../agent-actions/types.js"
import {
  applySimpleGoalTaskSummary,
  isSimpleGoal,
  managedGoalFromState,
  planManagedGoalTick,
  writeManagedGoalToState,
  type ManagedGoal,
} from "../goal/manager.js"
import { serializeGoalState } from "../goal/state.js"
import { expandManagedGoalState } from "../goal/typeDefinitions.js"
import { gh } from "../issue.js"
import type { GoalCtx } from "./goalCtx.js"
import { isAgentResponsibilityCadenceGoal, planGoalAgentResponsibilitySchedule, type GoalAgentResponsibilityScheduleState } from "./goalAgentResponsibilityScheduling.js"

export const advanceManagedGoal: PreflightScript = async (ctx) => {
  ctx.skipAgent = true

  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal?.raw) {
    ctx.output.exitCode = 1
    ctx.output.reason = "advanceManagedGoal requires loadGoalState first"
    return
  }

  ctx.data.goalOriginalStateText = serializeGoalState(goal.raw)

  goal.raw = expandManagedGoalState(goal.raw)
  const managed = managedGoalFromState(goal.raw)
  if (!managed) {
    ctx.output.reason = "goal has no managed-goal contract; nothing to advance"
    return
  }
  const previousGoalIdFact = managed.facts.goalId
  managed.facts.goalId = goal.id
  const restoreGoalIdFact = () => {
    if (previousGoalIdFact === undefined) delete managed.facts.goalId
    else managed.facts.goalId = previousGoalIdFact
  }

  try {
    ensureIssueFactIfNeeded(managed, goal.id, ctx.cwd)
  } catch (err) {
    const reason = `failed to prepare goal issue fact: ${err instanceof Error ? err.message : String(err)}`
    managed.stage = "blocked"
    if (!managed.blockers.includes(reason)) managed.blockers.push(reason)
    restoreGoalIdFact()
    goal.raw = writeManagedGoalToState({ ...goal.raw, state: goal.state }, managed)
    ctx.output.reason = reason
    return
  }

  if (isAgentResponsibilityCadenceGoal(managed, goal.raw.extra)) {
    const previousScheduleState =
      goal.raw.extra.scheduleState && typeof goal.raw.extra.scheduleState === "object"
        ? (goal.raw.extra.scheduleState as GoalAgentResponsibilityScheduleState)
        : undefined
    const decision = await planGoalAgentResponsibilitySchedule({
      goal: managed,
      cwd: ctx.cwd,
      config: ctx.config,
      previousScheduleState,
    })
    restoreGoalIdFact()
    goal.raw = writeManagedGoalToState({ ...goal.raw, state: goal.state }, managed)
    goal.raw.extra.scheduleState = decision.scheduleState
    ctx.data.managedGoalDecision = decision
    if (decision.kind === "dispatch" && decision.dispatch) {
      ctx.output.nextDispatch = {
        agentResponsibility: decision.dispatch.agentResponsibility,
        agentAction: decision.dispatch.agentAction,
        cliArgs: decision.dispatch.cliArgs,
      }
    }
    ctx.output.reason = decision.reason
    return
  }
  if (isSimpleGoal(managed)) {
    applySimpleGoalTaskSummary(managed, readSimpleGoalTaskSummary(goal.id, ctx.cwd))
  }

  const decision = planManagedGoalTick(managed)
  restoreGoalIdFact()
  ctx.data.managedGoalDecision = decision

  if (decision.kind === "done") {
    goal.state = "done"
  }

  goal.raw = writeManagedGoalToState({ ...goal.raw, state: goal.state }, managed)

  if (decision.kind === "blocked" || decision.kind === "wait" || decision.kind === "idle" || decision.kind === "done") {
    ctx.output.reason = decision.kind === "done" ? "managed goal complete" : decision.reason
    return
  }

  ctx.output.nextDispatch = {
    agentResponsibility: decision.agentResponsibility,
    agentAction: decision.agentAction,
    cliArgs: decision.cliArgs,
  }
  ctx.output.reason = `dispatch ${decision.agentResponsibility} for ${decision.evidence}`
}

function readSimpleGoalTaskSummary(goalId: string, cwd?: string): { total: number; open: number } {
  const raw = gh(
    ["issue", "list", "--state", "all", "--label", `goal:${goalId}`, "--limit", "1000", "--json", "number,state"],
    { cwd },
  )
  const issues = JSON.parse(raw) as Array<{ state?: string }>
  const total = issues.length
  const open = issues.filter((issue) => String(issue.state ?? "").toLowerCase() === "open").length
  return { total, open }
}

function ensureIssueFactIfNeeded(goal: ManagedGoal, goalId: string, cwd?: string): void {
  if (!routeNeedsIssueFact(goal)) return
  const existing = normalizeIssueNumber(goal.facts.issue)
  if (existing !== null) {
    goal.facts.issue = existing
    return
  }
  goal.facts.issue = findExistingGoalIssue(goalId, cwd) ?? createGoalIssue(goal, goalId, cwd)
}

function routeNeedsIssueFact(goal: ManagedGoal): boolean {
  return goal.route.some((step) =>
    Object.values(step.args ?? {}).some((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false
      const record = value as Record<string, unknown>
      return Object.keys(record).length === 1 && record.fact === "issue"
    }),
  )
}

function normalizeIssueNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  return null
}

function goalIssueMarker(goalId: string): string {
  return `<!-- kody-managed-goal: ${goalId} -->`
}

function findExistingGoalIssue(goalId: string, cwd?: string): number | null {
  const marker = goalIssueMarker(goalId)
  const raw = gh(["issue", "list", "--state", "all", "--limit", "100", "--json", "number,body"], { cwd })
  const issues = JSON.parse(raw) as Array<{ number?: number; body?: string }>
  const match = issues.find((issue) => typeof issue.number === "number" && issue.body?.includes(marker))
  return match?.number ?? null
}

function createGoalIssue(goal: ManagedGoal, goalId: string, cwd?: string): number {
  const prefix = goal.type === "release" ? "Release" : "Goal"
  const outcome = goal.destination.outcome.trim() || goalId
  const title = `${prefix}: ${outcome}`.slice(0, 120)
  const body = [
    `Managed goal: \`${goalId}\``,
    "",
    `Finish line: ${outcome}`,
    "",
    "This issue was created by Kody so goal agentResponsibilities that require an issue can run end to end.",
    "",
    goalIssueMarker(goalId),
  ].join("\n")
  const out = gh(["issue", "create", "--title", title, "--body-file", "-"], { input: body, cwd })
  const match = out.match(/\/issues\/(\d+)(?:[/?#]|$)/)
  if (!match) throw new Error(`gh issue create returned unexpected output: ${out}`)
  return Number(match[1])
}
