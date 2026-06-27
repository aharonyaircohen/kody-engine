import type { CapabilityEvidence } from "../capabilityEvidence.js"
import { readStateText, type StateRepoConfig, upsertStateText } from "../stateRepo.js"
import { managedGoalFromState } from "./manager.js"
import { goalRunLogSnapshot } from "./runLog.js"
import type { GoalState } from "./state.js"

const REPORT_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const GOAL_LOGS_KEY = "__goalRunLogs"

export interface GoalDashboardReportWrite {
  slug: string
  path: string
  changed: boolean
}

export interface GoalDashboardReportInput {
  config: StateRepoConfig
  cwd?: string
  data: Record<string, unknown>
  goalId: string
  state: GoalState
  evidenceItems?: CapabilityEvidence[]
}

export function goalDashboardReportRequested(data: Record<string, unknown>, state?: GoalState): boolean {
  return data.jobSaveReport === true || state?.extra.saveReport === true
}

export function refreshGoalDashboardReport(input: GoalDashboardReportInput): GoalDashboardReportWrite | null {
  const evidenceItems = input.evidenceItems ?? []
  if (!goalDashboardReportRequested(input.data, input.state)) return null
  if (!REPORT_SLUG_RE.test(input.goalId)) {
    throw new Error(`goal report: invalid goal id "${input.goalId}"`)
  }

  const filePath = `reports/${input.goalId}.md`
  const body = goalReportBody(
    input.goalId,
    input.state,
    snapshotFromState(input.goalId, input.state),
    latestGoalRunLogEvent(input.data, input.goalId),
    evidenceItems,
  )
  const current = readStateText(input.config, input.cwd, filePath)
  if (current?.content === body) {
    const report = { slug: input.goalId, path: current.path, changed: false }
    recordGoalReport(input.data, report)
    return report
  }

  upsertStateText(input.config, input.cwd, filePath, body, `chore(reports): refresh ${input.goalId}`)
  const report = { slug: input.goalId, path: filePath, changed: true }
  recordGoalReport(input.data, report)
  return report
}

export function capabilityEvidenceOutput(evidence: CapabilityEvidence): Record<string, unknown> {
  return {
    kind: "capability-evidence",
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

function goalReportBody(
  goalId: string,
  state: GoalState,
  snapshot: Record<string, unknown> | null,
  latestEvent: Record<string, unknown> | undefined,
  evidenceItems: CapabilityEvidence[],
): string {
  const outputs = evidenceItems.map(capabilityEvidenceOutput)
  const latestOutput = outputs.at(-1)
  const facts = recordField(snapshot, "facts") ?? recordField(state.extra, "facts") ?? {}
  const blockers = uniqueStrings([
    ...stringArrayField(snapshot, "blockers"),
    ...stringArrayField(latestEvent, "blockers"),
    ...evidenceItems.flatMap((item) => item.blockers),
  ])
  const missingEvidence = uniqueStrings([
    ...stringArrayField(snapshot, "missingEvidence"),
    ...evidenceItems.flatMap((item) => item.missingEvidence),
  ])
  const artifacts = uniqueArtifacts([
    ...evidenceItems.flatMap((item) => item.artifacts),
    ...artifactArrayField(latestEvent, "artifacts"),
  ])

  return [
    `# ${goalId}`,
    "",
    "## Status",
    `- State: ${state.state}`,
    `- Stage: ${stringField(snapshot, "stage") ?? stringField(state.extra, "stage") ?? "unknown"}`,
    `- Next step: ${nextStepFromEvent(state, snapshot, latestOutput, latestEvent)}`,
    `- Updated: ${state.updatedAt ?? state.createdAt ?? state.startedAt ?? "unknown"}`,
    "",
    "## Decision",
    `- Event: ${stringField(latestEvent, "event") ?? "unknown"}`,
    `- Reason: ${decisionReason(state, latestEvent, latestOutput, missingEvidence, blockers)}`,
    `- Required evidence: ${listOrNone(stringArrayField(snapshot, "requiredEvidence"))}`,
    `- Satisfied evidence: ${listOrNone(stringArrayField(snapshot, "satisfiedEvidence"))}`,
    `- Missing evidence: ${listOrNone(missingEvidence)}`,
    `- Blockers: ${listOrNone(blockers)}`,
    "",
    "## Dispatch",
    ...dispatchContextMarkdown(latestEvent),
    "",
    "## Capability Evidence",
    ...capabilityEvidenceMarkdown(outputs),
    "",
    "## Facts",
    fencedJson(facts),
    "",
    "## Artifacts",
    ...artifactMarkdown(artifacts),
    "",
  ].join("\n")
}

function capabilityEvidenceMarkdown(outputs: Record<string, unknown>[]): string[] {
  if (outputs.length === 0) return ["- none"]
  return outputs.flatMap((output, index) => evidenceOutputMarkdown(index + 1, output))
}

function decisionReason(
  state: GoalState,
  latestEvent: Record<string, unknown> | undefined,
  latestOutput: Record<string, unknown> | undefined,
  missingEvidence: string[],
  blockers: string[],
): string {
  if (state.state === "done") return "destination evidence satisfied"
  if (blockers.length > 0) return blockers[0] ?? "blocked"
  const eventReason = stringField(latestEvent, "reason") ?? stringField(recordField(latestEvent, "decision"), "reason")
  if (eventReason) return eventReason
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

function dispatchContextMarkdown(latestEvent: Record<string, unknown> | undefined): string[] {
  const context = recordField(latestEvent, "dispatchContext")
  if (!context) return ["- none"]
  const githubActor = stringField(context, "githubActor")
  const githubActorRole = stringField(context, "githubActorRole")
  const target = dispatchTargetLabel(recordField(context, "target"))
  return [
    `- Triggered by: ${stringField(context, "triggeredBy") ?? "unknown"}`,
    `- Mode: ${stringField(context, "dispatchMode") ?? "unknown"}`,
    `- GitHub actor: ${githubActor ? `${githubActor}${githubActorRole ? ` (${githubActorRole})` : ""}` : "none"}`,
    `- Decided by: ${stringField(context, "decidedBy") ?? "unknown"}`,
    `- Dispatched by: ${stringField(context, "dispatchedBy") ?? "unknown"}`,
    `- Target: ${target ?? "none"}`,
  ]
}

function dispatchTargetLabel(target: Record<string, unknown> | undefined): string | undefined {
  const type = stringField(target, "type")
  const id = stringField(target, "id")
  if (type && id) return `${type} ${id}`
  return id ?? type
}

function artifactMarkdown(artifacts: CapabilityEvidence["artifacts"]): string[] {
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

function stringArrayField(record: Record<string, unknown> | null | undefined, key: string): string[] {
  const value = record?.[key]
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []
}

function artifactArrayField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): CapabilityEvidence["artifacts"] {
  const value = record?.[key]
  if (!Array.isArray(value)) return []
  return value.filter(isArtifact)
}

function isArtifact(value: unknown): value is CapabilityEvidence["artifacts"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.label === "string" &&
    (record.url === undefined || typeof record.url === "string") &&
    (record.path === undefined || typeof record.path === "string")
  )
}

function uniqueArtifacts(artifacts: CapabilityEvidence["artifacts"]): CapabilityEvidence["artifacts"] {
  const seen = new Set<string>()
  const out: CapabilityEvidence["artifacts"] = []
  for (const artifact of artifacts) {
    const key = `${artifact.label}\n${artifact.url ?? ""}\n${artifact.path ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(artifact)
  }
  return out
}

function nextStepFromEvent(
  state: GoalState,
  goalAfter: Record<string, unknown> | null,
  capabilityOutput: Record<string, unknown> | undefined,
  latestEvent: Record<string, unknown> | undefined,
): "dispatch" | "wait" | "rescue" | "block" | "done" {
  if (state.state === "done") return "done"
  const decisionKind = stringField(recordField(latestEvent, "decision"), "kind") ?? stringField(latestEvent, "status")
  if (decisionKind === "done") return "done"
  if (decisionKind === "dispatch") return "dispatch"
  if (decisionKind === "blocked" || decisionKind === "reject-evidence") return "block"
  if (decisionKind === "wait" || decisionKind === "idle" || decisionKind === "no-state-change") return "wait"
  if (capabilityOutput) return nextStepFromEvidence(goalAfter, capabilityOutput)
  return "wait"
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

function snapshotFromState(goalId: string, state: GoalState): Record<string, unknown> | null {
  const managed = managedGoalFromState(state)
  return managed ? goalRunLogSnapshot(goalId, state.state, managed) : null
}

function latestGoalRunLogEvent(data: Record<string, unknown>, goalId: string): Record<string, unknown> | undefined {
  const logs = data[GOAL_LOGS_KEY]
  if (!logs || typeof logs !== "object" || Array.isArray(logs)) return undefined
  const log = (logs as Record<string, unknown>)[goalId]
  if (!log || typeof log !== "object" || Array.isArray(log)) return undefined
  const events = (log as Record<string, unknown>).events
  if (!Array.isArray(events)) return undefined
  const latest = events.at(-1)
  return latest && typeof latest === "object" && !Array.isArray(latest)
    ? (latest as Record<string, unknown>)
    : undefined
}

function recordGoalReport(data: Record<string, unknown>, report: GoalDashboardReportWrite): void {
  const prior = Array.isArray(data.goalReports) ? data.goalReports : []
  data.goalReports = [...prior, report]
}
