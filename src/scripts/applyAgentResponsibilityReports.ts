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
import { readStateText, upsertStateText } from "../stateRepo.js"

const REPORT_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

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

    const changed = serializeGoalState(next) !== serializeGoalState(prior)
    const nextForOutput = changed ? { ...next, updatedAt: nowIso() } : next

    writeGoalDashboardReport(
      ctx,
      goalId,
      nextForOutput,
      afterCompletionSnapshot ?? beforeCompletionSnapshot,
      goalEvidence,
    )

    if (!changed) {
      flushLogs(ctx)
      continue
    }
    putGoalState(ctx.config, goalId, nextForOutput, describeMessage(goalId, goalEvidence), ctx.cwd)
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

function writeGoalDashboardReport(
  ctx: Parameters<PostflightScript>[0],
  goalId: string,
  state: GoalState,
  snapshot: Record<string, unknown> | null,
  evidenceItems: AgentResponsibilityEvidence[],
): void {
  if (ctx.data.jobSaveReport !== true) return
  if (!REPORT_SLUG_RE.test(goalId)) {
    fail(ctx, `goal report: invalid goal id "${goalId}"`)
    return
  }

  const filePath = `reports/${goalId}.md`
  const body = goalReportBody(goalId, state, snapshot, evidenceItems)
  try {
    const current = readStateText(ctx.config, ctx.cwd, filePath)
    if (current?.content === body) {
      recordGoalReport(ctx.data, { slug: goalId, path: current.path, changed: false })
      return
    }
    upsertStateText(ctx.config, ctx.cwd, filePath, body, `chore(reports): refresh ${goalId}`)
    recordGoalReport(ctx.data, { slug: goalId, path: filePath, changed: true })
  } catch (err) {
    fail(ctx, `goal report: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function recordGoalReport(
  data: Record<string, unknown>,
  report: { slug: string; path: string; changed: boolean },
): void {
  const prior = Array.isArray(data.goalReports) ? data.goalReports : []
  data.goalReports = [...prior, report]
}

function goalReportBody(
  goalId: string,
  state: GoalState,
  snapshot: Record<string, unknown> | null,
  evidenceItems: AgentResponsibilityEvidence[],
): string {
  const outputs = evidenceItems.map(responsibilityEvidenceOutput)
  const latestOutput = outputs.at(-1)
  const nextStep =
    state.state === "done" ? "done" : latestOutput ? nextStepFromEvidence(snapshot, latestOutput) : "wait"
  const facts = recordField(snapshot, "facts") ?? recordField(state.extra, "facts") ?? {}
  const blockers = uniqueStrings([
    ...stringArrayField(snapshot, "blockers"),
    ...evidenceItems.flatMap((item) => item.blockers),
  ])
  const missingEvidence = uniqueStrings([
    ...stringArrayField(snapshot, "missingEvidence"),
    ...evidenceItems.flatMap((item) => item.missingEvidence),
  ])
  const artifacts = uniqueArtifacts(evidenceItems.flatMap((item) => item.artifacts))

  return [
    `# ${goalId}`,
    "",
    "## Status",
    `- State: ${state.state}`,
    `- Stage: ${stringField(snapshot, "stage") ?? stringField(state.extra, "stage") ?? "unknown"}`,
    `- Next step: ${nextStep}`,
    `- Updated: ${state.updatedAt ?? state.createdAt ?? state.startedAt ?? "unknown"}`,
    "",
    "## Decision",
    `- Reason: ${decisionReason(state, latestOutput, missingEvidence, blockers)}`,
    `- Required evidence: ${listOrNone(stringArrayField(snapshot, "requiredEvidence"))}`,
    `- Satisfied evidence: ${listOrNone(stringArrayField(snapshot, "satisfiedEvidence"))}`,
    `- Missing evidence: ${listOrNone(missingEvidence)}`,
    `- Blockers: ${listOrNone(blockers)}`,
    "",
    "## Responsibility Evidence",
    ...outputs.flatMap((output, index) => evidenceOutputMarkdown(index + 1, output)),
    "",
    "## Facts",
    fencedJson(facts),
    "",
    "## Artifacts",
    ...artifactMarkdown(artifacts),
    "",
  ].join("\n")
}

function decisionReason(
  state: GoalState,
  latestOutput: Record<string, unknown> | undefined,
  missingEvidence: string[],
  blockers: string[],
): string {
  if (state.state === "done") return "destination evidence satisfied"
  if (blockers.length > 0) return blockers[0] ?? "blocked"
  const summary = stringField(latestOutput, "summary")
  if (summary) return summary
  if (missingEvidence.length > 0) return `waiting for ${missingEvidence[0]}`
  return "waiting for more evidence"
}

function evidenceOutputMarkdown(index: number, output: Record<string, unknown>): string[] {
  return [
    `### Output ${index}`,
    `- Status: ${stringField(output, "status") ?? "unknown"}`,
    `- Summary: ${stringField(output, "summary") ?? "no summary"}`,
    `- Sources: ${listOrNone(stringArrayField(output, "sources"))}`,
    `- Evidence values: ${inlineJson(recordField(output, "evidence") ?? {})}`,
    `- Missing evidence: ${listOrNone(stringArrayField(output, "missingEvidence"))}`,
    `- Blockers: ${listOrNone(stringArrayField(output, "blockers"))}`,
    "",
  ]
}

function artifactMarkdown(artifacts: AgentResponsibilityEvidence["artifacts"]): string[] {
  if (artifacts.length === 0) return ["- none"]
  return artifacts.map((artifact) => {
    if (artifact.url) return `- [${artifact.label}](${artifact.url})`
    return `- ${artifact.label}: ${artifact.path}`
  })
}

function fencedJson(value: Record<string, unknown>): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n")
}

function inlineJson(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function listOrNone(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none"
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function recordField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key]
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : undefined
}

function uniqueArtifacts(
  artifacts: AgentResponsibilityEvidence["artifacts"],
): AgentResponsibilityEvidence["artifacts"] {
  const seen = new Set<string>()
  const out: AgentResponsibilityEvidence["artifacts"] = []
  for (const artifact of artifacts) {
    const key = `${artifact.label}\n${artifact.url ?? ""}\n${artifact.path ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(artifact)
  }
  return out
}

function fail(ctx: Parameters<PostflightScript>[0], reason: string): void {
  ctx.output.reason = ctx.output.reason ? `${ctx.output.reason}; ${reason}` : reason
  if (ctx.output.exitCode === 0) ctx.output.exitCode = 99
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
