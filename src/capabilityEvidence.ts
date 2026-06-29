import type { CapabilityReport } from "./capabilityReport.js"
import type { CapabilityResult, CapabilityResultArtifact, CapabilityResultStatus } from "./capabilityResult.js"
import type { GoalState } from "./goal/state.js"

export type CapabilityEvidenceSource = "report" | "result"

export interface CapabilityEvidence {
  version: 1
  target: { type: "goal"; id: string }
  status: CapabilityResultStatus
  summary: string
  evidence?: Record<string, boolean>
  explicitEvidence?: string
  facts: Record<string, unknown>
  artifacts: CapabilityResultArtifact[]
  missingEvidence: string[]
  blockers: string[]
  sources: CapabilityEvidenceSource[]
}

const CONTROL_FACT_KEYS = new Set(["blockers", "destination", "capabilities", "route", "stage", "state"])

export function capabilityReportToEvidence(report: CapabilityReport): CapabilityEvidence | null {
  if (report.target.type !== "goal") return null
  const evidence = report.evidence ?? {}
  const values = Object.values(evidence)
  const status = values.some((value) => value === false)
    ? "fail"
    : values.length > 0 || report.facts
      ? "changed"
      : "noop"
  return {
    version: 1,
    target: { type: "goal", id: report.target.id },
    status,
    summary: "capability reported goal evidence",
    evidence,
    facts: report.facts ?? {},
    artifacts: [],
    missingEvidence: [],
    blockers: [],
    sources: ["report"],
  }
}

export function capabilityResultToEvidence(
  result: CapabilityResult,
  fallbackGoalId: string | null,
  explicitEvidence?: string,
): CapabilityEvidence | null {
  if (result.target && result.target.type !== "goal") return null
  const targetId = result.target?.id ?? fallbackGoalId
  if (!targetId) return null
  const hasEvidenceValues = Object.keys(result.evidence ?? {}).length > 0
  return {
    version: 1,
    target: { type: "goal", id: targetId },
    status: result.status,
    summary: result.summary,
    evidence: result.evidence,
    explicitEvidence: hasEvidenceValues ? undefined : explicitEvidence,
    facts: result.facts,
    artifacts: result.artifacts,
    missingEvidence: result.missingEvidence,
    blockers: result.blockers,
    sources: ["result"],
  }
}

export function mergeCapabilityEvidence(items: CapabilityEvidence[]): CapabilityEvidence[] {
  const reports = items.filter((item) => item.sources.includes("report") && !item.sources.includes("result"))
  const results = items.filter((item) => item.sources.includes("result"))
  const usedReports = new Set<number>()
  const merged: CapabilityEvidence[] = []

  for (const result of results) {
    const reportIndex = reports.findIndex(
      (report, index) => !usedReports.has(index) && evidenceMatches(report, result, reports),
    )
    if (reportIndex >= 0) {
      usedReports.add(reportIndex)
      merged.push(mergeReportAndResult(reports[reportIndex]!, result))
    } else {
      merged.push(result)
    }
  }

  for (let i = 0; i < reports.length; i += 1) {
    if (!usedReports.has(i)) merged.push(reports[i]!)
  }
  return merged
}

export function applyCapabilityEvidenceToGoalState(state: GoalState, evidence: CapabilityEvidence): GoalState {
  const priorFacts = parseFacts(state.extra.facts) ?? {}
  const nextFacts: Record<string, unknown> = { ...priorFacts }

  for (const [key, value] of Object.entries(evidence.facts)) {
    if (CONTROL_FACT_KEYS.has(key)) continue
    nextFacts[key] = value
  }
  for (const [key, value] of Object.entries(evidence.evidence ?? {})) {
    nextFacts[key] = value
  }

  const pending = typeof nextFacts.pendingEvidence === "string" ? nextFacts.pendingEvidence : ""
  const hasEvidenceValues = Object.keys(evidence.evidence ?? {}).length > 0
  const statusEvidence = evidence.explicitEvidence || (hasEvidenceValues ? "" : pending)
  const hasPendingEvidenceValue = pending ? Object.hasOwn(evidence.evidence ?? {}, pending) : false
  const terminalStatus = evidence.status === "pass" || evidence.status === "fail" || evidence.status === "blocked"
  if (statusEvidence && !Object.hasOwn(evidence.evidence ?? {}, statusEvidence)) {
    if (evidence.status === "pass") nextFacts[statusEvidence] = true
    if (evidence.status === "fail" || evidence.status === "blocked") nextFacts[statusEvidence] = false
  }

  if (pending && (hasPendingEvidenceValue || (statusEvidence === pending && terminalStatus))) {
    delete nextFacts.pendingEvidence
  }

  const blockers = parseStringArray(state.extra.blockers) ?? []
  const evidenceBlockers =
    evidence.blockers.length > 0 || (evidence.status !== "fail" && evidence.status !== "blocked")
      ? evidence.blockers
      : [evidence.summary]
  for (const blocker of evidenceBlockers) {
    if (!blockers.includes(blocker)) blockers.push(blocker)
  }

  const nextExtra: GoalState["extra"] = {
    ...state.extra,
    facts: nextFacts,
  }
  if (blockers.length > 0 || Array.isArray(state.extra.blockers)) {
    nextExtra.blockers = blockers
  }

  return {
    ...state,
    extra: nextExtra,
  }
}

function evidenceMatches(
  report: CapabilityEvidence,
  result: CapabilityEvidence,
  allReports: CapabilityEvidence[],
): boolean {
  if (report.target.id !== result.target.id) return false
  if (result.explicitEvidence && Object.hasOwn(report.evidence ?? {}, result.explicitEvidence)) return true

  const resultEvidenceKeys = Object.keys(result.evidence ?? {})
  if (resultEvidenceKeys.length > 0 && resultEvidenceKeys.some((key) => Object.hasOwn(report.evidence ?? {}, key))) {
    return true
  }

  return (
    !result.explicitEvidence &&
    resultEvidenceKeys.length === 0 &&
    allReports.filter((item) => item.target.id === result.target.id).length === 1
  )
}

function mergeReportAndResult(report: CapabilityEvidence, result: CapabilityEvidence): CapabilityEvidence {
  return {
    ...result,
    evidence: mergeOptionalRecords(report.evidence, result.evidence),
    facts: { ...report.facts, ...result.facts },
    artifacts: uniqueArtifacts([...report.artifacts, ...result.artifacts]),
    missingEvidence: uniqueStrings([...report.missingEvidence, ...result.missingEvidence]),
    blockers: uniqueStrings([...report.blockers, ...result.blockers]),
    sources: uniqueSources([...report.sources, ...result.sources]),
  }
}

function mergeOptionalRecords(
  left: Record<string, boolean> | undefined,
  right: Record<string, boolean> | undefined,
): Record<string, boolean> | undefined {
  const merged = { ...(left ?? {}), ...(right ?? {}) }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function uniqueSources(values: CapabilityEvidenceSource[]): CapabilityEvidenceSource[] {
  const order: CapabilityEvidenceSource[] = ["report", "result"]
  const set = new Set(values)
  return order.filter((source) => set.has(source))
}

function uniqueArtifacts(artifacts: CapabilityResultArtifact[]): CapabilityResultArtifact[] {
  const seen = new Set<string>()
  const out: CapabilityResultArtifact[] = []
  for (const artifact of artifacts) {
    const key = `${artifact.label}\n${artifact.url ?? ""}\n${artifact.path ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(artifact)
  }
  return out
}

function parseFacts(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null

  const facts: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim()) return null
    if (CONTROL_FACT_KEYS.has(key)) continue
    facts[key] = value
  }
  return facts
}

function parseStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== "string") return null
    out.push(item)
  }
  return out
}
