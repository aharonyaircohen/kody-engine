import type { AgentResult } from "../agent.js"
import type { PostflightScript } from "../agent-actions/types.js"
import {
  type AgentResponsibilityReport,
  applyAgentResponsibilityReportToGoalState,
  parseAgentResponsibilityReport,
  parseAgentResponsibilityReportsFromText,
} from "../agent-responsibilityReport.js"
import {
  type AgentResponsibilityResult,
  applyAgentResponsibilityResultToObjectiveState,
  parseAgentResponsibilityResult,
  parseAgentResponsibilityResultsFromText,
} from "../agent-responsibilityResult.js"
import { managedGoalFromState, planManagedGoalTick, writeManagedGoalToState } from "../goal/manager.js"
import { flushGoalRunLogEvents, stageGoalRunLogEvent } from "../goal/runLog.js"
import { type GoalState, nowIso, serializeGoalState } from "../goal/state.js"
import { fetchGoalState, putGoalState } from "../goal/stateStore.js"

export const applyAgentResponsibilityReports: PostflightScript = async (ctx, _profile, agentResult) => {
  const reports = collectReports(ctx.data.agentResponsibilityReports, agentResult)
  const results = collectResults(ctx.data.dutyResults, agentResult)
  const resultGoalId = typeof ctx.args.goal === "string" && ctx.args.goal.length > 0 ? ctx.args.goal : null
  if (reports.length === 0 && (results.length === 0 || !resultGoalId)) return

  const reportsByGoal = groupGoalReports(reports)
  const goalIds = new Set(reportsByGoal.keys())
  if (results.length > 0 && resultGoalId) goalIds.add(resultGoalId)

  for (const goalId of goalIds) {
    const prior = fetchGoalState(ctx.config, goalId, ctx.cwd)
    if (!prior) {
      process.stderr.write(`[kody agentResponsibility-report] goal ${goalId} missing in state repo; report skipped\n`)
      continue
    }

    let next: GoalState = prior
    for (const report of reportsByGoal.get(goalId) ?? []) {
      stageGoalRunLogEvent(ctx.data, goalId, {
        source: "goal-report",
        event: "goal.evidence.reported",
        goalState: prior.state,
        evidenceValues: report.evidence,
        facts: report.facts,
      })
      next = applyAgentResponsibilityReportToGoalState(next, report)
    }
    if (goalId === resultGoalId) {
      const evidence =
        typeof ctx.args.evidence === "string" && ctx.args.evidence.length > 0 ? ctx.args.evidence : undefined
      for (const result of results) {
        stageGoalRunLogEvent(ctx.data, goalId, {
          source: "goal-report",
          event: "goal.result.applied",
          goalState: prior.state,
          evidence,
          status: result.status,
          reason: result.summary,
          facts: result.facts,
          artifacts: result.artifacts,
        })
        next = applyAgentResponsibilityResultToObjectiveState(next, result, evidence)
      }
    }
    next = completeSatisfiedManagedGoal(next)
    if (prior.state !== "done" && next.state === "done") {
      stageGoalRunLogEvent(ctx.data, goalId, {
        source: "goal-report",
        event: "goal.completed",
        goalState: "done",
        status: "done",
        reason: "destination evidence satisfied",
      })
    }

    if (serializeGoalState(next) === serializeGoalState(prior)) {
      flushLogs(ctx)
      continue
    }
    putGoalState(
      ctx.config,
      goalId,
      { ...next, updatedAt: nowIso() },
      describeMessage(goalId, reportsByGoal.get(goalId), results),
      ctx.cwd,
    )
    flushLogs(ctx)
  }
}

function flushLogs(ctx: Parameters<PostflightScript>[0]): void {
  try {
    flushGoalRunLogEvents(ctx.config, ctx.cwd, ctx.data)
  } catch (err) {
    process.stderr.write(
      `[kody agentResponsibility-report] goal log persist failed (${err instanceof Error ? err.message : String(err)})\n`,
    )
  }
}

function collectReports(raw: unknown, agentResult: AgentResult | null): AgentResponsibilityReport[] {
  const out: AgentResponsibilityReport[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = parseAgentResponsibilityReport(item)
      if (parsed) out.push(parsed)
    }
  }
  if (agentResult?.finalText) out.push(...parseAgentResponsibilityReportsFromText(agentResult.finalText))
  return out
}

function collectResults(raw: unknown, agentResult: AgentResult | null): AgentResponsibilityResult[] {
  const out: AgentResponsibilityResult[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = parseAgentResponsibilityResult(item)
      if (parsed) out.push(parsed)
    }
  }
  if (agentResult?.finalText) out.push(...parseAgentResponsibilityResultsFromText(agentResult.finalText))
  return out
}

function groupGoalReports(reports: AgentResponsibilityReport[]): Map<string, AgentResponsibilityReport[]> {
  const grouped = new Map<string, AgentResponsibilityReport[]>()
  for (const report of reports) {
    if (report.target.type !== "goal") continue
    const list = grouped.get(report.target.id) ?? []
    list.push(report)
    grouped.set(report.target.id, list)
  }
  return grouped
}

function completeSatisfiedManagedGoal(state: GoalState): GoalState {
  if (state.state !== "active") return state
  const managed = managedGoalFromState(state)
  if (!managed) return state
  if (!managed.destination.evidence.every((evidence) => managed.facts[evidence] === true)) return state
  const decision = planManagedGoalTick(managed)
  if (decision.kind !== "done") return state
  return writeManagedGoalToState({ ...state, state: "done" }, managed)
}

function describeMessage(
  goalId: string,
  reports: AgentResponsibilityReport[] | undefined,
  results: AgentResponsibilityResult[],
): string {
  const pieces: string[] = []
  if (reports && reports.length > 0) pieces.push(`report=${reports.length}`)
  if (results.length > 0) pieces.push(`result=${results.map((result) => result.status).join(",")}`)
  return `Apply agentResponsibility output to ${goalId}${pieces.length > 0 ? ` (${pieces.join("; ")})` : ""}`
}
