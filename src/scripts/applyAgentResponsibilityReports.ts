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
import { flushGoalRunLogEvents, goalRunLogChange, goalRunLogSnapshot, stageGoalRunLogEvent } from "../goal/runLog.js"
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
      stageGoalRunLogEvent(ctx.data, goalId, {
        source: "goal-loop",
        event: "goal.evidence.rejected",
        status: "rejected",
        reason: "goal missing in state repo",
        inspection: {
          responsibilityOutput: {
            reports: reportsByGoal.get(goalId)?.length ?? 0,
            results: goalId === resultGoalId ? results.length : 0,
          },
          missingEvidence: [],
          blockers: ["goal missing in state repo"],
        },
        decision: { kind: "reject-evidence", nextStep: "block", reason: "goal missing in state repo" },
      })
      flushLogs(ctx)
      process.stderr.write(`[kody agentResponsibility-report] goal ${goalId} missing in state repo; report skipped\n`)
      continue
    }

    let next: GoalState = prior
    for (const report of reportsByGoal.get(goalId) ?? []) {
      const beforeSnapshot = snapshotFromState(goalId, next)
      next = applyAgentResponsibilityReportToGoalState(next, report)
      const afterSnapshot = snapshotFromState(goalId, next)
      const change = goalRunLogChange(beforeSnapshot, afterSnapshot)
      const output = responsibilityReportOutput(report, afterSnapshot)
      stageGoalRunLogEvent(ctx.data, goalId, {
        source: "goal-loop",
        event: change ? "goal.evidence.applied" : "goal.evidence.unchanged",
        goalState: next.state,
        evidenceValues: report.evidence,
        facts: report.facts,
        goal: afterSnapshot ?? undefined,
        inspection: evidenceInspection(beforeSnapshot, afterSnapshot, output),
        decision: {
          ...evidenceDecision(change, afterSnapshot, output),
          evidence: report.evidence,
        },
        change,
      })
    }
    if (goalId === resultGoalId) {
      const evidence =
        typeof ctx.args.evidence === "string" && ctx.args.evidence.length > 0 ? ctx.args.evidence : undefined
      for (const result of results) {
        const beforeSnapshot = snapshotFromState(goalId, next)
        next = applyAgentResponsibilityResultToObjectiveState(next, result, evidence)
        const afterSnapshot = snapshotFromState(goalId, next)
        const change = goalRunLogChange(beforeSnapshot, afterSnapshot)
        const output = responsibilityResultOutput(result)
        stageGoalRunLogEvent(ctx.data, goalId, {
          source: "goal-loop",
          event: change ? "goal.evidence.applied" : "goal.evidence.unchanged",
          goalState: next.state,
          evidence,
          status: result.status,
          reason: result.summary,
          facts: result.facts,
          artifacts: result.artifacts,
          goal: afterSnapshot ?? beforeSnapshot ?? undefined,
          inspection: evidenceInspection(beforeSnapshot, afterSnapshot, output, evidence),
          decision: {
            ...evidenceDecision(change, afterSnapshot, output),
            evidence,
          },
          change,
        })
      }
    }
    const beforeCompletionSnapshot = snapshotFromState(goalId, next)
    next = completeSatisfiedManagedGoal(next)
    const afterCompletionSnapshot = snapshotFromState(goalId, next)
    if (prior.state !== "done" && next.state === "done") {
      stageGoalRunLogEvent(ctx.data, goalId, {
        source: "goal-loop",
        event: "goal.decision.done",
        goalState: "done",
        status: "done",
        reason: "destination evidence satisfied",
        goal: afterCompletionSnapshot ?? undefined,
        inspection: {
          requiredEvidence: beforeCompletionSnapshot?.requiredEvidence,
          satisfiedEvidence: beforeCompletionSnapshot?.satisfiedEvidence,
          missingEvidence: beforeCompletionSnapshot?.missingEvidence,
        },
        decision: { kind: "done", nextStep: "done", reason: "destination evidence satisfied" },
        change: goalRunLogChange(beforeCompletionSnapshot, afterCompletionSnapshot),
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

function snapshotFromState(goalId: string, state: GoalState): Record<string, unknown> | null {
  const managed = managedGoalFromState(state)
  return managed ? goalRunLogSnapshot(goalId, state.state, managed) : null
}

function responsibilityReportOutput(
  report: AgentResponsibilityReport,
  goalAfter: Record<string, unknown> | null,
): Record<string, unknown> {
  const evidence = report.evidence ?? {}
  const values = Object.values(evidence)
  const status = values.some((value) => value === false)
    ? "fail"
    : values.length > 0 || report.facts
      ? "changed"
      : "noop"
  return {
    kind: "report",
    status,
    summary: "responsibility reported goal evidence",
    evidence,
    facts: report.facts ?? {},
    artifacts: [],
    missingEvidence: stringArrayField(goalAfter, "missingEvidence"),
    blockers: stringArrayField(goalAfter, "blockers"),
  }
}

function responsibilityResultOutput(result: AgentResponsibilityResult): Record<string, unknown> {
  return {
    kind: "result",
    status: result.status,
    summary: result.summary,
    facts: result.facts,
    artifacts: result.artifacts,
    missingEvidence: result.missingEvidence,
    blockers: result.blockers,
  }
}

function evidenceInspection(
  goalBefore: Record<string, unknown> | null,
  goalAfter: Record<string, unknown> | null,
  responsibilityOutput: Record<string, unknown>,
  explicitEvidence?: string,
): Record<string, unknown> {
  return {
    expectedEvidence: {
      required: goalBefore?.requiredEvidence,
      missingBefore: goalBefore?.missingEvidence,
      pendingBefore: goalBefore?.pendingEvidence,
      explicit: explicitEvidence,
    },
    responsibilityOutput,
    actualGoalState: {
      satisfiedEvidence: goalAfter?.satisfiedEvidence,
      missingEvidence: goalAfter?.missingEvidence,
      pendingEvidence: goalAfter?.pendingEvidence,
      blockers: goalAfter?.blockers,
    },
  }
}

function evidenceDecision(
  change: Record<string, unknown> | undefined,
  goalAfter: Record<string, unknown> | null,
  responsibilityOutput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: change ? "accept-evidence" : "no-state-change",
    status: responsibilityOutput.status,
    nextStep: nextStepFromEvidence(goalAfter, responsibilityOutput),
    reason: responsibilityOutput.summary,
  }
}

function nextStepFromEvidence(
  goalAfter: Record<string, unknown> | null,
  responsibilityOutput: Record<string, unknown>,
): "dispatch" | "wait" | "rescue" | "block" | "done" {
  const status = typeof responsibilityOutput.status === "string" ? responsibilityOutput.status : ""
  const outputBlockers = stringArrayField(responsibilityOutput, "blockers")
  const goalBlockers = stringArrayField(goalAfter, "blockers")
  const missingEvidence = stringArrayField(goalAfter, "missingEvidence")
  if (goalAfter && missingEvidence.length === 0) return "done"
  if (status === "fail" || status === "blocked" || outputBlockers.length > 0) return "rescue"
  if (goalBlockers.length > 0) return "block"
  if (missingEvidence.length > 0 && status !== "noop") return "dispatch"
  return "wait"
}

function stringArrayField(record: Record<string, unknown> | null | undefined, key: string): string[] {
  const value = record?.[key]
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []
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
