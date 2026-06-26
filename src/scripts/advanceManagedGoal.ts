import type { PreflightScript } from "../executables/types.js"
import {
  applySimpleGoalTaskSummary,
  isSimpleGoal,
  type ManagedGoal,
  type ManagedGoalDecision,
  managedGoalFromState,
  planManagedGoalTick,
  writeManagedGoalToState,
} from "../goal/manager.js"
import { goalRunLogChange, goalRunLogSnapshot, stageGoalRunLogEvent } from "../goal/runLog.js"
import { serializeGoalState } from "../goal/state.js"
import { expandManagedGoalState } from "../goal/typeDefinitions.js"
import { gh } from "../issue.js"
import {
  type GoalCapabilityScheduleState,
  isCapabilityCadenceGoal,
  isGoalTargetLoop,
  planGoalCapabilitySchedule,
  planGoalTargetLoopSchedule,
} from "./goalCapabilityScheduling.js"
import type { GoalCtx } from "./goalCtx.js"

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
  const startSnapshot = goalRunLogSnapshot(goal.id, goal.state, managed)
  stageGoalRunLogEvent(ctx.data, goal.id, {
    source: "goal-manager",
    event: "goal.tick.start",
    goalType: managed.type,
    goalState: goal.state,
    stage: managed.stage,
    goal: startSnapshot,
    inspection: {
      requiredEvidence: startSnapshot.requiredEvidence,
      satisfiedEvidence: startSnapshot.satisfiedEvidence,
      missingEvidence: startSnapshot.missingEvidence,
      pendingEvidence: startSnapshot.pendingEvidence,
      blockers: startSnapshot.blockers,
    },
    facts: managed.facts,
  })
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
    const blockedSnapshot = goalRunLogSnapshot(goal.id, goal.state, managed)
    stageGoalRunLogEvent(ctx.data, goal.id, {
      source: "goal-manager",
      event: "goal.tick.blocked",
      goalType: managed.type,
      goalState: goal.state,
      stage: managed.stage,
      status: "blocked",
      reason,
      goal: blockedSnapshot,
      inspection: {
        purpose: "prepare goal issue fact before dispatch",
        routeNeedsIssueFact: true,
      },
      decision: { kind: "blocked", reason },
      change: goalRunLogChange(startSnapshot, blockedSnapshot),
    })
    ctx.output.reason = reason
    return
  }

  if (isGoalTargetLoop(managed)) {
    const beforeSnapshot = goalRunLogSnapshot(goal.id, goal.state, managed)
    const previousScheduleState =
      goal.raw.extra.scheduleState && typeof goal.raw.extra.scheduleState === "object"
        ? (goal.raw.extra.scheduleState as GoalCapabilityScheduleState)
        : undefined
    const decision = planGoalTargetLoopSchedule({ goal: managed, previousScheduleState })
    restoreGoalIdFact()
    goal.raw = writeManagedGoalToState({ ...goal.raw, state: goal.state }, managed)
    goal.raw.extra.scheduleState = decision.scheduleState
    ctx.data.managedGoalDecision = decision
    if (decision.kind === "dispatch" && decision.dispatch) {
      ctx.output.nextDispatch = {
        action: decision.dispatch.action,
        executable: decision.dispatch.executable,
        cliArgs: decision.dispatch.cliArgs,
      }
    }
    stageGoalRunLogEvent(ctx.data, goal.id, {
      source: "goal-manager",
      event: decision.kind === "dispatch" ? "loop.tick.dispatch" : `loop.tick.${decision.kind}`,
      goalType: managed.type,
      goalState: goal.state,
      stage: managed.stage,
      status: decision.kind,
      reason: decision.reason,
      target:
        decision.dispatch?.cliArgs.goal && typeof decision.dispatch.cliArgs.goal === "string"
          ? { type: "goal", id: decision.dispatch.cliArgs.goal }
          : managed.loopTarget,
      dispatch: decision.dispatch,
      goal: goalRunLogSnapshot(goal.id, goal.state, managed),
      inspection: {
        loopTarget: managed.loopTarget,
        preferredRunTime: managed.preferredRunTime,
        previousScheduleState,
        scheduleState: decision.scheduleState,
      },
      decision: {
        kind: decision.kind,
        reason: decision.reason,
        dispatch: decision.dispatch,
      },
      change: {
        ...(goalRunLogChange(beforeSnapshot, goalRunLogSnapshot(goal.id, goal.state, managed)) ?? {}),
        scheduleState: {
          previousDecision: previousScheduleState?.lastDecision,
          nextDecision: decision.scheduleState.lastDecision,
        },
      },
    })
    ctx.output.reason = decision.reason
    return
  }

  if (isCapabilityCadenceGoal(managed, goal.raw.extra)) {
    const beforeSnapshot = goalRunLogSnapshot(goal.id, goal.state, managed)
    const previousScheduleState =
      goal.raw.extra.scheduleState && typeof goal.raw.extra.scheduleState === "object"
        ? (goal.raw.extra.scheduleState as GoalCapabilityScheduleState)
        : undefined
    const decision = await planGoalCapabilitySchedule({
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
        capability: decision.dispatch.capability,
        executable: decision.dispatch.executable,
        cliArgs: decision.dispatch.cliArgs,
        ...(goal.raw.extra.saveReport === true ? { saveReport: true } : {}),
      }
    }
    stageGoalRunLogEvent(ctx.data, goal.id, {
      source: "goal-manager",
      event: decision.kind === "dispatch" ? "loop.tick.dispatch" : `loop.tick.${decision.kind}`,
      goalType: managed.type,
      goalState: goal.state,
      stage: managed.stage,
      status: decision.kind,
      reason: decision.reason,
      dispatch: decision.dispatch,
      goal: goalRunLogSnapshot(goal.id, goal.state, managed),
      inspection: {
        capabilities: decision.scheduleState.capabilities,
        previousScheduleState,
        scheduleState: decision.scheduleState,
      },
      decision: {
        kind: decision.kind,
        reason: decision.reason,
        dispatch: decision.dispatch,
      },
      change: {
        ...(goalRunLogChange(beforeSnapshot, goalRunLogSnapshot(goal.id, goal.state, managed)) ?? {}),
        scheduleState: {
          previousDecision: previousScheduleState?.lastDecision,
          nextDecision: decision.scheduleState.lastDecision,
        },
      },
    })
    ctx.output.reason = decision.reason
    return
  }
  let simpleTaskSummary: { total: number; open: number } | undefined
  if (isSimpleGoal(managed)) {
    simpleTaskSummary = readSimpleGoalTaskSummary(goal.id, ctx.cwd)
    applySimpleGoalTaskSummary(managed, simpleTaskSummary)
  }

  const beforeDecisionSnapshot = goalRunLogSnapshot(goal.id, goal.state, managed)
  const decision = planManagedGoalTick(managed)
  restoreGoalIdFact()
  ctx.data.managedGoalDecision = decision

  if (decision.kind === "done") {
    goal.state = "done"
  }

  goal.raw = writeManagedGoalToState({ ...goal.raw, state: goal.state }, managed)
  const afterDecisionSnapshot = goalRunLogSnapshot(goal.id, goal.state, managed)
  stageManagedGoalDecision(ctx.data, goal.id, managed, goal.state, decision, {
    goalSnapshot: afterDecisionSnapshot,
    inspection: {
      requiredEvidence: beforeDecisionSnapshot.requiredEvidence,
      satisfiedEvidence: beforeDecisionSnapshot.satisfiedEvidence,
      missingEvidence: beforeDecisionSnapshot.missingEvidence,
      pendingEvidence: beforeDecisionSnapshot.pendingEvidence,
      route: beforeDecisionSnapshot.route,
      simpleTaskSummary,
    },
    change: goalRunLogChange(beforeDecisionSnapshot, afterDecisionSnapshot),
  })

  if (decision.kind === "blocked" || decision.kind === "wait" || decision.kind === "idle" || decision.kind === "done") {
    ctx.output.reason = decision.kind === "done" ? "managed goal complete" : decision.reason
    return
  }

  ctx.output.nextDispatch = {
    capability: decision.capability,
    executable: decision.executable,
    cliArgs: decision.cliArgs,
    ...(decision.saveReport === true ? { saveReport: true } : {}),
  }
  ctx.output.reason = `dispatch ${decision.capability} for ${decision.evidence}`
}

function stageManagedGoalDecision(
  data: Record<string, unknown>,
  goalId: string,
  goal: ManagedGoal,
  goalState: string,
  decision: ManagedGoalDecision,
  details: {
    goalSnapshot: Record<string, unknown>
    inspection: Record<string, unknown>
    change: Record<string, unknown> | undefined
  },
): void {
  if (decision.kind === "dispatch") {
    stageGoalRunLogEvent(data, goalId, {
      source: "goal-manager",
      event: "goal.tick.dispatch",
      goalType: goal.type,
      goalState,
      stage: decision.stage,
      evidence: decision.evidence,
      status: decision.kind,
      dispatch: {
        capability: decision.capability,
        executable: decision.executable,
        cliArgs: decision.cliArgs,
      },
      goal: details.goalSnapshot,
      inspection: details.inspection,
      decision: {
        kind: decision.kind,
        evidence: decision.evidence,
        stage: decision.stage,
        capability: decision.capability,
        executable: decision.executable,
        cliArgs: decision.cliArgs,
      },
      change: details.change,
    })
    return
  }

  if (decision.kind === "done") {
    stageGoalRunLogEvent(data, goalId, {
      source: "goal-manager",
      event: "goal.tick.done",
      goalType: goal.type,
      goalState: "done",
      stage: "done",
      status: decision.kind,
      reason: "managed goal complete",
      goal: details.goalSnapshot,
      inspection: details.inspection,
      decision: { kind: decision.kind, reason: "managed goal complete" },
      change: details.change,
    })
    return
  }

  if (decision.kind === "idle") {
    stageGoalRunLogEvent(data, goalId, {
      source: "goal-manager",
      event: "goal.tick.idle",
      goalType: goal.type,
      goalState,
      stage: goal.stage,
      status: decision.kind,
      reason: decision.reason,
      goal: details.goalSnapshot,
      inspection: details.inspection,
      decision: { kind: decision.kind, reason: decision.reason },
      change: details.change,
    })
    return
  }

  stageGoalRunLogEvent(data, goalId, {
    source: "goal-manager",
    event: `goal.tick.${decision.kind}`,
    goalType: goal.type,
    goalState,
    stage: decision.stage,
    evidence: decision.evidence,
    status: decision.kind,
    reason: decision.reason,
    goal: details.goalSnapshot,
    inspection: details.inspection,
    decision: {
      kind: decision.kind,
      evidence: decision.evidence,
      stage: decision.stage,
      reason: decision.reason,
    },
    change: details.change,
  })
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
    "This issue was created by Kody so goal capabilities that require an issue can run end to end.",
    "",
    goalIssueMarker(goalId),
  ].join("\n")
  const out = gh(["issue", "create", "--title", title, "--body-file", "-"], { input: body, cwd })
  const match = out.match(/\/issues\/(\d+)(?:[/?#]|$)/)
  if (!match) throw new Error(`gh issue create returned unexpected output: ${out}`)
  return Number(match[1])
}
