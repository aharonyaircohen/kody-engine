import type { PreflightScript } from "../executables/types.js"
import {
  applySimpleGoalTaskSummary,
  isSimpleGoal,
  managedGoalFromState,
  planManagedGoalTick,
  writeManagedGoalToState,
} from "../goal/manager.js"
import { serializeGoalState } from "../goal/state.js"
import { gh } from "../issue.js"
import type { GoalCtx } from "./goalCtx.js"
import { isDutyCadenceGoal, planGoalDutySchedule, type GoalDutyScheduleState } from "./goalDutyScheduling.js"

export const advanceManagedGoal: PreflightScript = async (ctx) => {
  ctx.skipAgent = true

  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal?.raw) {
    ctx.output.exitCode = 1
    ctx.output.reason = "advanceManagedGoal requires loadGoalState first"
    return
  }

  ctx.data.goalOriginalStateText = serializeGoalState(goal.raw)

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
  if (isDutyCadenceGoal(managed, goal.raw.extra)) {
    const previousScheduleState =
      goal.raw.extra.scheduleState && typeof goal.raw.extra.scheduleState === "object"
        ? (goal.raw.extra.scheduleState as GoalDutyScheduleState)
        : undefined
    const decision = await planGoalDutySchedule({
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
        duty: decision.dispatch.duty,
        executable: decision.dispatch.executable,
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
    duty: decision.duty,
    executable: decision.executable,
    cliArgs: decision.cliArgs,
  }
  ctx.output.reason = `dispatch ${decision.duty} for ${decision.evidence}`
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
