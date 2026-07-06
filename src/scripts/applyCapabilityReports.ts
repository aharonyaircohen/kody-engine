import type { AgentResult } from "../agent.js"
import {
  applyCapabilityEvidenceToGoalState,
  type CapabilityEvidence,
  capabilityReportToEvidence,
  capabilityResultToEvidence,
  mergeCapabilityEvidence,
} from "../capabilityEvidence.js"
import { type CapabilityReport, parseCapabilityReport, parseCapabilityReportsFromText } from "../capabilityReport.js"
import { type CapabilityResult, parseCapabilityResult, parseCapabilityResultsFromText } from "../capabilityResult.js"
import type { PostflightScript } from "../executables/types.js"
import { mergeGoalEvidenceProgress, parseGoalEvidenceState } from "../goal/evidenceState.js"
import { managedGoalFromState, planManagedGoalTick, writeManagedGoalToState } from "../goal/manager.js"
import { capabilityEvidenceOutput, refreshGoalDashboardReport } from "../goal/report.js"
import { flushGoalRunLogEvents, goalRunLogChange, goalRunLogSnapshot, stageGoalRunLogEvent } from "../goal/runLog.js"
import { type GoalState, nowIso, serializeGoalState } from "../goal/state.js"
import { fetchGoalState, putGoalState } from "../goal/stateStore.js"
import { gh } from "../issue.js"

export const applyCapabilityReports: PostflightScript = async (ctx, _profile, agentResult) => {
  const reports = collectReports(ctx.data.capabilityReports, agentResult)
  const results = collectResults(ctx.data.capabilityResults, agentResult)
  const resultTarget = parseResultTarget(ctx.data.capabilityResultTarget)
  const resultGoalId =
    resultTarget?.id ?? (typeof ctx.args.goal === "string" && ctx.args.goal.length > 0 ? ctx.args.goal : null)
  const explicitEvidence =
    resultTarget?.evidence ??
    (typeof ctx.args.evidence === "string" && ctx.args.evidence.length > 0 ? ctx.args.evidence : undefined)
  const evidenceItems = collectGoalCapabilityEvidence(reports, results, resultGoalId, explicitEvidence)
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
          capabilityOutput: {
            kind: "capability-evidence",
            count: goalEvidence.length,
            items: goalEvidence.map(capabilityEvidenceOutput),
          },
          missingEvidence: [],
          blockers: ["goal missing in state repo"],
        },
        decision: { kind: "reject-evidence", nextStep: "block", reason: "goal missing in state repo" },
      })
      flushLogs(ctx)
      process.stderr.write(`[kody capability-report] goal ${goalId} missing in state repo; report skipped\n`)
      continue
    }

    let next: GoalState = prior
    for (const evidence of goalEvidence) {
      const beforeSnapshot = snapshotFromState(goalId, next)
      next = applyCapabilityEvidenceToGoalState(next, evidence)
      next = ensureNeedsFixIssue(ctx, goalId, next, evidence, evidenceKeyFromOutput(evidence, beforeSnapshot))
      const afterSnapshot = snapshotFromState(goalId, next)
      const change = goalRunLogChange(beforeSnapshot, afterSnapshot)
      const output = capabilityEvidenceOutput(evidence)
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

    const changed = serializeGoalState(next) !== serializeGoalState(prior)
    const nextForOutput = changed ? { ...next, updatedAt: nowIso() } : next

    try {
      if (changed) {
        putGoalState(ctx.config, goalId, nextForOutput, describeMessage(goalId, goalEvidence), ctx.cwd)
      }
      refreshReportOrFail(ctx, goalId, nextForOutput, goalEvidence)
      if (changed && ctx.output.exitCode === 0 && !ctx.output.nextDispatch && shouldResumeManagedGoal(goalId, nextForOutput)) {
        ctx.output.nextDispatch = {
          action: "goal-manager",
          implementation: "goal-manager",
          cliArgs: { goal: goalId },
        }
      }
    } finally {
      flushLogs(ctx)
    }
  }
}

function ensureNeedsFixIssue(
  ctx: Parameters<PostflightScript>[0],
  goalId: string,
  state: GoalState,
  evidence: CapabilityEvidence,
  evidenceKey: string,
): GoalState {
  if (evidence.resultClass !== "needsFix" || !evidenceKey) return state
  const evidenceState = parseGoalEvidenceState(state.extra.evidenceState)
  const progress = evidenceState[evidenceKey]
  if (progress?.issue) return state

  const issue = findExistingNeedsFixIssue(goalId, evidenceKey, ctx.cwd) ?? createNeedsFixIssue(goalId, evidenceKey, evidence, ctx.cwd)
  const nextEvidenceState = mergeGoalEvidenceProgress(evidenceState, evidenceKey, {
    resultClass: "needsFix",
    attempts: progress?.attempts ?? 1,
    reason: evidence.summary,
    nextAction: `fix issue #${issue}`,
    issue,
    updatedAt: nowIso(),
  })
  return {
    ...state,
    extra: {
      ...state.extra,
      evidenceState: nextEvidenceState,
      reason: evidence.summary,
      nextAction: `fix issue #${issue}`,
    },
  }
}

function evidenceKeyFromOutput(evidence: CapabilityEvidence, beforeSnapshot: Record<string, unknown> | null): string {
  if (evidence.explicitEvidence) return evidence.explicitEvidence
  const keys = Object.keys(evidence.evidence ?? {})
  if (keys.length === 1) return keys[0]!
  const pending = beforeSnapshot?.pendingEvidence
  return typeof pending === "string" ? pending : ""
}

function needsFixIssueMarker(goalId: string, evidence: string): string {
  return `<!-- kody-managed-goal-needs-fix: ${goalId}:${evidence} -->`
}

function findExistingNeedsFixIssue(goalId: string, evidence: string, cwd?: string): number | null {
  const marker = needsFixIssueMarker(goalId, evidence)
  const raw = gh(["issue", "list", "--state", "all", "--limit", "100", "--json", "number,body"], { cwd })
  const issues = JSON.parse(raw) as Array<{ number?: number; body?: string }>
  const match = issues.find((issue) => typeof issue.number === "number" && issue.body?.includes(marker))
  return match?.number ?? null
}

function createNeedsFixIssue(goalId: string, evidence: string, result: CapabilityEvidence, cwd?: string): number {
  const title = `Goal ${goalId}: fix ${evidence}`.slice(0, 120)
  const body = [
    `Managed goal: \`${goalId}\``,
    `Evidence: \`${evidence}\``,
    "",
    `Reason: ${result.summary}`,
    "",
    result.blockers.length > 0 ? `Blockers: ${result.blockers.join(", ")}` : "Blockers: none",
    "",
    needsFixIssueMarker(goalId, evidence),
  ].join("\n")
  const out = gh(["issue", "create", "--title", title, "--body-file", "-"], { input: body, cwd })
  const match = out.match(/\/issues\/(\d+)(?:[/?#]|$)/)
  if (!match) throw new Error(`gh issue create returned unexpected output: ${out}`)
  return Number(match[1])
}

function flushLogs(ctx: Parameters<PostflightScript>[0]): void {
  try {
    flushGoalRunLogEvents(ctx.config, ctx.cwd, ctx.data)
  } catch (err) {
    process.stderr.write(
      `[kody capability-report] goal log persist failed (${err instanceof Error ? err.message : String(err)})\n`,
    )
  }
}

function refreshReportOrFail(
  ctx: Parameters<PostflightScript>[0],
  goalId: string,
  state: GoalState,
  evidenceItems: CapabilityEvidence[],
): void {
  try {
    refreshGoalDashboardReport({
      config: ctx.config,
      cwd: ctx.cwd,
      data: ctx.data,
      goalId,
      state,
      evidenceItems,
    })
  } catch (err) {
    fail(ctx, err instanceof Error ? err.message : String(err))
  }
}

function fail(ctx: Parameters<PostflightScript>[0], reason: string): void {
  ctx.output.reason = ctx.output.reason ? `${ctx.output.reason}; ${reason}` : reason
  if (ctx.output.exitCode === 0) ctx.output.exitCode = 99
}

function collectReports(raw: unknown, agentResult: AgentResult | null): CapabilityReport[] {
  const out: CapabilityReport[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = parseCapabilityReport(item)
      if (parsed) out.push(parsed)
    }
  }
  if (agentResult?.finalText) out.push(...parseCapabilityReportsFromText(agentResult.finalText))
  return out
}

function collectResults(raw: unknown, agentResult: AgentResult | null): CapabilityResult[] {
  const out: CapabilityResult[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = parseCapabilityResult(item)
      if (parsed) out.push(parsed)
    }
  }
  if (agentResult?.finalText) out.push(...parseCapabilityResultsFromText(agentResult.finalText))
  return out
}

function parseResultTarget(raw: unknown): { type: "goal"; id: string; evidence?: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const target = raw as Record<string, unknown>
  if (target.type !== "goal") return null
  if (typeof target.id !== "string" || target.id.trim().length === 0) return null
  const evidence =
    typeof target.evidence === "string" && target.evidence.trim().length > 0 ? target.evidence.trim() : undefined
  return {
    type: "goal",
    id: target.id.trim(),
    ...(evidence ? { evidence } : {}),
  }
}

function collectGoalCapabilityEvidence(
  reports: CapabilityReport[],
  results: CapabilityResult[],
  fallbackGoalId: string | null,
  explicitEvidence?: string,
): CapabilityEvidence[] {
  const items: CapabilityEvidence[] = []
  for (const report of reports) {
    const evidence = capabilityReportToEvidence(report)
    if (evidence) items.push(evidence)
  }
  for (const result of results) {
    const evidence = capabilityResultToEvidence(result, fallbackGoalId, explicitEvidence)
    if (evidence) items.push(evidence)
  }
  return mergeCapabilityEvidence(items)
}

function groupGoalEvidence(evidenceItems: CapabilityEvidence[]): Map<string, CapabilityEvidence[]> {
  const grouped = new Map<string, CapabilityEvidence[]>()
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

function shouldResumeManagedGoal(goalId: string, state: GoalState): boolean {
  if (state.state !== "active") return false
  const managed = managedGoalFromState(state)
  if (!managed) return false
  if (managed.blockers.length > 0) return false
  if (managed.facts.goalId === undefined) managed.facts.goalId = goalId
  return planManagedGoalTick(managed).kind === "dispatch"
}

function snapshotFromState(goalId: string, state: GoalState): Record<string, unknown> | null {
  const managed = managedGoalFromState(state)
  return managed ? goalRunLogSnapshot(goalId, state.state, managed) : null
}

function evidenceInspection(
  goalBefore: Record<string, unknown> | null,
  goalAfter: Record<string, unknown> | null,
  capabilityOutput: Record<string, unknown>,
  explicitEvidence?: string,
): Record<string, unknown> {
  return {
    expectedEvidence: {
      required: goalBefore?.requiredEvidence,
      missingBefore: goalBefore?.missingEvidence,
      pendingBefore: goalBefore?.pendingEvidence,
      explicit: explicitEvidence,
    },
    capabilityOutput,
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
  capabilityOutput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: change ? "accept-evidence" : "no-state-change",
    status: capabilityOutput.status,
    nextStep: nextStepFromEvidence(goalAfter, capabilityOutput),
    reason: capabilityOutput.summary,
  }
}

function nextStepFromEvidence(
  goalAfter: Record<string, unknown> | null,
  capabilityOutput: Record<string, unknown>,
): "dispatch" | "wait" | "rescue" | "block" | "done" {
  const status = typeof capabilityOutput.status === "string" ? capabilityOutput.status : ""
  const outputBlockers = stringArrayField(capabilityOutput, "blockers")
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

function describeMessage(goalId: string, evidenceItems: CapabilityEvidence[]): string {
  const pieces = evidenceItems.map((evidence) => `${evidence.sources.join("+")}:${evidence.status}`)
  return `Apply capability output to ${goalId}${pieces.length > 0 ? ` (${pieces.join("; ")})` : ""}`
}
