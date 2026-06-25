import type { AgentResult } from "../agent.js"
import type { PostflightScript } from "../agent-actions/types.js"
import {
  type AgentResponsibilityEvidence,
  agentResponsibilityReportToEvidence,
  agentResponsibilityResultToEvidence,
  applyAgentResponsibilityEvidenceToGoalState,
  mergeResponsibilityEvidence,
} from "../agent-responsibilityEvidence.js"
import {
  type AgentResponsibilityReport,
  parseAgentResponsibilityReport,
  parseAgentResponsibilityReportsFromText,
} from "../agent-responsibilityReport.js"
import {
  type AgentResponsibilityResult,
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
  const explicitEvidence =
    typeof ctx.args.evidence === "string" && ctx.args.evidence.length > 0 ? ctx.args.evidence : undefined
  const evidenceItems = collectGoalResponsibilityEvidence(reports, results, resultGoalId, explicitEvidence)
  if (evidenceItems.length === 0) return

  const evidenceByGoal = groupGoalEvidence(evidenceItems)

  for (const [goalId, goalEvidence] of evidenceByGoal) {
    const prior = fetchGoalState(ctx.config, goalId, ctx.cwd)
    if (!prior) {
      stageGoalRunLogEvent(ctx.data, goalId, {
        source: "goal-loop",
        event: "goal.evidence.rejected",
        status: "rejected",
        reason: "goal missing in state repo",
        inspection: {
          responsibilityOutput: {
            kind: "responsibility-evidence",
            count: goalEvidence.length,
            items: goalEvidence.map(responsibilityEvidenceOutput),
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
    for (const evidence of goalEvidence) {
      const beforeSnapshot = snapshotFromState(goalId, next)
      next = applyAgentResponsibilityEvidenceToGoalState(next, evidence)
      const afterSnapshot = snapshotFromState(goalId, next)
      const change = goalRunLogChange(beforeSnapshot, afterSnapshot)
      const output = responsibilityEvidenceOutput(evidence)
      stageGoalRunLogEvent(ctx.data, goalId, {
        source: "goal-loop",
        event: change ? "goal.evidence.applied" : "goal.evidence.unchanged",
        goalState: next.state,
        evidence: evidence.explicitEvidence,
        evidenceValues: evidence.evidence,
        status: evidence.status,
        reason: evidence.summary,
        facts: evidence.facts,
        artifacts: evidence.artifacts,
        goal: afterSnapshot ?? undefined,
        inspection: evidenceInspection(beforeSnapshot, afterSnapshot, output, evidence.explicitEvidence),
        decision: {
          ...evidenceDecision(change, afterSnapshot, output),
          evidence: evidence.explicitEvidence,
          evidenceValues: evidence.evidence,
        },
        change,
      })
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
    putGoalState(ctx.config, goalId, { ...next, updatedAt: nowIso() }, describeMessage(goalId, goalEvidence), ctx.cwd)
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

function collectGoalResponsibilityEvidence(
  reports: AgentResponsibilityReport[],
  results: AgentResponsibilityResult[],
  fallbackGoalId: string | null,
  explicitEvidence?: string,
): AgentResponsibilityEvidence[] {
  const items: AgentResponsibilityEvidence[] = []
  for (const report of reports) {
    const evidence = agentResponsibilityReportToEvidence(report)
    if (evidence) items.push(evidence)
  }
  for (const result of results) {
    const evidence = agentResponsibilityResultToEvidence(result, fallbackGoalId, explicitEvidence)
    if (evidence) items.push(evidence)
  }
  return mergeResponsibilityEvidence(items)
}

function groupGoalEvidence(evidenceItems: AgentResponsibilityEvidence[]): Map<string, AgentResponsibilityEvidence[]> {
  const grouped = new Map<string, AgentResponsibilityEvidence[]>()
  for (const evidence of evidenceItems) {
    const list = grouped.get(evidence.target.id) ?? []
    list.push(evidence)
    grouped.set(evidence.target.id, list)
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

function responsibilityEvidenceOutput(evidence: AgentResponsibilityEvidence): Record<string, unknown> {
  return {
    kind: "responsibility-evidence",
    sources: evidence.sources,
    status: evidence.status,
    summary: evidence.summary,
    evidence: evidence.evidence ?? {},
    facts: evidence.facts,
    artifacts: evidence.artifacts,
    missingEvidence: evidence.missingEvidence,
    blockers: evidence.blockers,
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

function describeMessage(goalId: string, evidenceItems: AgentResponsibilityEvidence[]): string {
  const pieces = evidenceItems.map((evidence) => `${evidence.sources.join("+")}:${evidence.status}`)
  return `Apply agentResponsibility output to ${goalId}${pieces.length > 0 ? ` (${pieces.join("; ")})` : ""}`
}
