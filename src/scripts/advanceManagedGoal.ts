import { capabilitiesRoot } from "../definition-paths.js"
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
import type { GoalState } from "../goal/state.js"
import { serializeGoalState } from "../goal/state.js"
import { fetchGoalStateAsync } from "../goal/stateStore.js"
import {
  type GoalLoopTargetResolution,
  goalLoopNow,
  resolveActiveGoalLoopTarget,
  resolveGoalLoopTarget,
} from "../goal/targetLoopResolution.js"
import { expandManagedGoalState } from "../goal/typeDefinitions.js"
import type { PreflightScript } from "../implementations/types.js"

import { gh } from "../issue.js"
import { resolveCapabilityFolder } from "../registry.js"
import { hasStateBackendConfig } from "../state-backend.js"
import { readTrustModeOverrideAsync, type TrustModeOverride, type TrustSubject } from "../trustPolicy.js"
import { readWorkflowDefinition } from "../workflowDefinitions.js"
import {
  type GoalCapabilityScheduleState,
  isCapabilityCadenceGoal,
  isGoalTargetLoop,
  isWorkflowTargetLoop,
  planGoalCapabilitySchedule,
  planTargetLoopSchedule,
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

  if (isGoalTargetLoop(managed) || isWorkflowTargetLoop(managed)) {
    const beforeSnapshot = goalRunLogSnapshot(goal.id, goal.state, managed)
    const previousScheduleState =
      goal.raw.extra.scheduleState && typeof goal.raw.extra.scheduleState === "object"
        ? (goal.raw.extra.scheduleState as GoalCapabilityScheduleState)
        : undefined
    const now = goalLoopNow()
    const activeTarget = isGoalTargetLoop(managed)
      ? await resolveActiveGoalLoopTarget(ctx.config, ctx.cwd, goal.id, managed)
      : null
    const allowSameDayTargetDispatch =
      isGoalTargetLoop(managed) && (!!activeTarget || previousDispatchWasTargetInstance(managed, previousScheduleState))
    let decision = planTargetLoopSchedule({
      goal: managed,
      previousScheduleState,
      now,
      allowSameDayTargetDispatch,
    })
    let targetResolution: GoalLoopTargetResolution | undefined
    const selfAutonomyBlock =
      decision.kind === "dispatch" && decision.dispatch
        ? await autonomyBlockReason(ctx, goal.id, managed, goal.raw, decision.dispatch, { checkTargets: false })
        : null
    if (selfAutonomyBlock) {
      restoreGoalIdFact()
      goal.raw = writeManagedGoalToState({ ...goal.raw, state: goal.state }, managed)
      const waitDecision = scheduleWaitDecision(previousScheduleState, decision, selfAutonomyBlock)
      goal.raw.extra.scheduleState = waitDecision.scheduleState
      ctx.data.managedGoalDecision = waitDecision
      stageAutonomyBlocked(ctx.data, goal.id, managed, goal.state, waitDecision, previousScheduleState)
      ctx.output.reason = selfAutonomyBlock
      return
    }
    if (decision.kind === "dispatch" && decision.dispatch && isGoalTargetLoop(managed)) {
      targetResolution = await resolveGoalLoopTarget(ctx.config, ctx.cwd, goal.id, managed, now)
      decision = planTargetLoopSchedule({
        goal: managed,
        previousScheduleState,
        now,
        resolvedGoalTargetId: targetResolution.targetId,
        allowSameDayTargetDispatch,
      })
    }
    restoreGoalIdFact()
    goal.raw = writeManagedGoalToState({ ...goal.raw, state: goal.state }, managed)
    const autonomyBlock =
      decision.kind === "dispatch" && decision.dispatch
        ? await autonomyBlockReason(ctx, goal.id, managed, goal.raw, decision.dispatch)
        : null
    if (autonomyBlock) {
      const waitDecision = scheduleWaitDecision(previousScheduleState, decision, autonomyBlock)
      goal.raw.extra.scheduleState = waitDecision.scheduleState
      ctx.data.managedGoalDecision = waitDecision
      stageAutonomyBlocked(ctx.data, goal.id, managed, goal.state, waitDecision, previousScheduleState)
      ctx.output.reason = autonomyBlock
      return
    }
    goal.raw.extra.scheduleState = decision.scheduleState
    ctx.data.managedGoalDecision = decision
    if (decision.kind === "dispatch" && decision.dispatch) {
      ctx.output.nextDispatch = {
        ...(decision.dispatch.action ? { action: decision.dispatch.action } : {}),
        ...(decision.dispatch.capability ? { capability: decision.dispatch.capability } : {}),
        ...(decision.dispatch.workflow ? { workflow: decision.dispatch.workflow } : {}),
        ...(decision.dispatch.implementation ? { implementation: decision.dispatch.implementation } : {}),
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
        ...(targetResolution ? { targetResolution } : {}),
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
    const autonomyBlock =
      decision.kind === "dispatch" && decision.dispatch
        ? await autonomyBlockReason(ctx, goal.id, managed, goal.raw, decision.dispatch)
        : null
    if (autonomyBlock) {
      const waitDecision = scheduleWaitDecision(previousScheduleState, decision, autonomyBlock)
      goal.raw.extra.scheduleState = waitDecision.scheduleState
      ctx.data.managedGoalDecision = waitDecision
      stageAutonomyBlocked(ctx.data, goal.id, managed, goal.state, waitDecision, previousScheduleState)
      ctx.output.reason = autonomyBlock
      return
    }
    goal.raw.extra.scheduleState = decision.scheduleState
    ctx.data.managedGoalDecision = decision
    if (decision.kind === "dispatch" && decision.dispatch) {
      ctx.output.nextDispatch = {
        capability: decision.dispatch.capability,
        implementation: decision.dispatch.implementation,
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
  if (decision.kind === "dispatch" || decision.kind === "dispatchWorkflow") {
    const planned =
      decision.kind === "dispatchWorkflow"
        ? { workflow: decision.workflow, cliArgs: decision.cliArgs }
        : {
            capability: decision.capability,
            ...(decision.implementation ? { implementation: decision.implementation } : {}),
            cliArgs: decision.cliArgs,
          }
    const autonomyBlock = await autonomyBlockReason(ctx, goal.id, managed, goal.raw, planned)
    if (autonomyBlock) {
      stageAutonomyBlocked(ctx.data, goal.id, managed, goal.state, autonomyBlock)
      ctx.output.reason = autonomyBlock
      return
    }
  }
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

  if (decision.kind === "dispatchWorkflow") {
    ctx.output.nextDispatch = {
      workflow: decision.workflow,
      cliArgs: decision.cliArgs,
      workflowFacts: scalarFacts(managed.facts),
      evidence: decision.evidence,
      ...(decision.saveReport === true ? { saveReport: true } : {}),
      resultTarget: { type: "goal", id: goal.id },
    }
    ctx.output.reason = `dispatch workflow ${decision.workflow} for ${decision.evidence}`
    return
  }

  ctx.output.nextDispatch = {
    capability: decision.capability,
    cliArgs: decision.cliArgs,
    evidence: decision.evidence,
    ...(decision.implementation ? { implementation: decision.implementation } : {}),
    ...(decision.saveReport === true ? { saveReport: true } : {}),
    resultTarget: { type: "goal", id: goal.id },
  }
  ctx.output.reason = `dispatch ${decision.capability} for ${decision.evidence}`
}

function scalarFacts(facts: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(facts).filter(
      ([key, value]) =>
        key !== "pendingEvidence" &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
    ),
  )
}

/** True when every step capability declares capabilityKind observe or verify. */
export function workflowIsObserveOnly(capabilities: readonly string[], cwd: string): boolean {
  if (capabilities.length === 0) return false
  const root = capabilitiesRoot(cwd)
  return capabilities.every((slug) => {
    const folder = resolveCapabilityFolder(slug, root)
    const kind = folder?.config.capabilityKind
    return kind === "observe" || kind === "verify"
  })
}

type PlannedDispatch = {
  action?: string
  capability?: string
  workflow?: string
  implementation?: string
  cliArgs: Record<string, unknown>
}

async function autonomyBlockReason(
  ctx: Parameters<PreflightScript>[0],
  goalId: string,
  goal: ManagedGoal,
  goalState: GoalState,
  dispatch: PlannedDispatch,
  options: { checkTargets?: boolean } = {},
): Promise<string | null> {
  if (ctx.data.jobForce === true) return null
  const selfKind = managedModelKind(goal)
  const selfMode =
    selfKind === "Goal" ? await firstTrustOverride(ctx, subjectCandidates("goal", goalId, goalState)) : null
  if (selfKind === "Goal" && (selfMode === "ask" || (selfMode !== "auto" && goal.runWithoutApproval !== true))) {
    return `Run without approval is off for ${managedModelKind(goal)} ${goalId}`
  }

  // Enabling a Loop is the operator's approval for its declared target.
  // Keep the workflow's own approval gate for Goals and standalone runs.
  if (dispatch.workflow && selfKind === "Goal") {
    const workflowMode = await firstTrustOverride(ctx, [{ kind: "workflow", id: dispatch.workflow }])
    const workflow = workflowMode === "auto" ? null : readWorkflowDefinition(ctx.config, ctx.cwd, dispatch.workflow)
    if (workflowMode === "ask" || (workflowMode !== "auto" && workflow && workflow.runWithoutApproval !== true)) {
      // Observe/verify-only workflows cannot change anything — they run
      // without approval unless explicitly pinned to "ask" in the ledger.
      if (workflowMode !== "ask" && workflow && workflowIsObserveOnly(workflow.capabilities, ctx.cwd)) {
        return null
      }
      return `Run without approval is off for workflow ${dispatch.workflow}`
    }
  }

  const targetGoal =
    dispatch.action === "goal-manager" && typeof dispatch.cliArgs.goal === "string" ? dispatch.cliArgs.goal : null
  if (targetGoal && targetGoal !== goalId && options.checkTargets !== false) {
    const target = await fetchGoalStateAsync(ctx.config, targetGoal, ctx.cwd)
    const targetManaged = target ? managedGoalFromState(expandManagedGoalState(target)) : null
    const targetIsGoal = targetManaged ? managedModelKind(targetManaged) === "Goal" : false
    const targetMode =
      targetManaged && targetIsGoal
        ? await firstTrustOverride(ctx, subjectCandidates("goal", targetGoal, target))
        : null
    if (
      targetIsGoal &&
      (targetMode === "ask" || (targetMode !== "auto" && targetManaged && targetManaged.runWithoutApproval !== true))
    ) {
      return `Run without approval is off for goal ${targetGoal}`
    }
  }

  return null
}

function scheduleWaitDecision(
  previousScheduleState: GoalCapabilityScheduleState | undefined,
  plannedDecision: { scheduleState: GoalCapabilityScheduleState },
  reason: string,
): { kind: "wait"; reason: string; scheduleState: GoalCapabilityScheduleState } {
  const at = plannedDecision.scheduleState.lastGoalTickAt
  return {
    kind: "wait",
    reason,
    scheduleState: {
      mode: "agentLoop",
      lastGoalTickAt: previousScheduleState?.lastGoalTickAt ?? plannedDecision.scheduleState.lastGoalTickAt,
      lastDecision: { kind: "wait", reason, at },
      capabilities:
        previousScheduleState?.capabilities ?? unmarkPlannedCapabilityDispatch(plannedDecision.scheduleState, at),
    },
  }
}

function unmarkPlannedCapabilityDispatch(
  scheduleState: GoalCapabilityScheduleState,
  at: string,
): GoalCapabilityScheduleState["capabilities"] {
  return Object.fromEntries(
    Object.entries(scheduleState.capabilities).map(([slug, status]) => {
      if (status.lastFiredAt !== at) return [slug, status]
      const rest = { ...status }
      delete rest.lastFiredAt
      return [slug, rest]
    }),
  )
}

function managedModelKind(goal: ManagedGoal): "Loop" | "Goal" {
  return goal.loopTarget || goal.schedule ? "Loop" : "Goal"
}

function subjectCandidates(kind: "loop" | "goal", id: string, state: GoalState | null): TrustSubject[] {
  const ids = new Set<string>()
  ids.add(id)
  if (state?.extra) {
    for (const key of ["sourceTemplate", "templateId", "template"]) {
      const value = state.extra[key]
      if (typeof value === "string" && value.trim()) ids.add(value.trim())
    }
  }
  return [...ids].map((candidate) => ({ kind, id: candidate }))
}

async function firstTrustOverride(
  ctx: Parameters<PreflightScript>[0],
  subjects: TrustSubject[],
): Promise<TrustModeOverride> {
  const backendConfigured = hasStateBackendConfig()
  if (!backendConfigured) return null
  const repoSlug =
    ctx.config.github?.owner && ctx.config.github?.repo ? `${ctx.config.github.owner}/${ctx.config.github.repo}` : ""
  for (const subject of subjects) {
    const mode = await readTrustModeOverrideAsync(repoSlug, subject)
    if (mode) return mode
  }
  return null
}

function stageAutonomyBlocked(
  data: Record<string, unknown>,
  goalId: string,
  goal: ManagedGoal,
  goalState: string,
  waitDecision: string | { kind: "wait"; reason: string; scheduleState: GoalCapabilityScheduleState },
  previousScheduleState?: GoalCapabilityScheduleState,
): void {
  const reason = typeof waitDecision === "string" ? waitDecision : waitDecision.reason
  const scheduleState = typeof waitDecision === "string" ? undefined : waitDecision.scheduleState
  stageGoalRunLogEvent(data, goalId, {
    source: "goal-manager",
    event: "goal.tick.wait",
    goalType: goal.type,
    goalState,
    stage: goal.stage,
    status: "wait",
    reason,
    goal: goalRunLogSnapshot(goalId, goalState, goal),
    ...(scheduleState
      ? {
          inspection: {
            previousScheduleState,
            scheduleState,
          },
          change: {
            scheduleState: {
              previousDecision: previousScheduleState?.lastDecision,
              nextDecision: scheduleState.lastDecision,
            },
          },
        }
      : {}),
    decision: { kind: "wait", reason },
  })
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
  if (decision.kind === "dispatch" || decision.kind === "dispatchWorkflow") {
    stageGoalRunLogEvent(data, goalId, {
      source: "goal-manager",
      event: "goal.tick.dispatch",
      goalType: goal.type,
      goalState,
      stage: decision.stage,
      evidence: decision.evidence,
      status: decision.kind,
      dispatch:
        decision.kind === "dispatchWorkflow"
          ? {
              workflow: decision.workflow,
              cliArgs: decision.cliArgs,
            }
          : {
              capability: decision.capability,
              cliArgs: decision.cliArgs,
              ...(decision.implementation ? { implementation: decision.implementation } : {}),
            },
      goal: details.goalSnapshot,
      inspection: details.inspection,
      decision:
        decision.kind === "dispatchWorkflow"
          ? {
              kind: decision.kind,
              evidence: decision.evidence,
              stage: decision.stage,
              workflow: decision.workflow,
              cliArgs: decision.cliArgs,
            }
          : {
              kind: decision.kind,
              evidence: decision.evidence,
              stage: decision.stage,
              capability: decision.capability,
              cliArgs: decision.cliArgs,
              ...(decision.implementation ? { implementation: decision.implementation } : {}),
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

function previousDispatchWasTargetInstance(
  managed: ManagedGoal,
  previousScheduleState: GoalCapabilityScheduleState | undefined,
): boolean {
  const targetId = managed.loopTarget?.id.trim()
  const previous = previousScheduleState?.lastDecision
  if (!targetId || previous?.kind !== "dispatch" || !("targetType" in previous) || previous.targetType !== "goal") {
    return false
  }
  return previous.targetId === targetId || previous.targetId.startsWith(`${targetId}-`)
}

function ensureIssueFactIfNeeded(goal: ManagedGoal, goalId: string, cwd?: string): void {
  if (!routeNeedsIssueFact(goal) && !workflowNeedsIssueFact(goal)) return
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

function workflowNeedsIssueFact(goal: ManagedGoal): boolean {
  return Object.values(goal.workflowRef?.args ?? {}).some(isIssueFactReference)
}

function isIssueFactReference(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 1 && record.fact === "issue"
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
