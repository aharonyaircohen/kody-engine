import {
  type CapabilityReportTarget,
  parseCapabilityReportEvidence,
  parseCapabilityReportTarget,
} from "./capabilityReport.js"
import { type GoalEvidenceResultClass, isGoalEvidenceResultClass } from "./goal/evidenceState.js"
import type { GoalState } from "./goal/state.js"

export const CAPABILITY_RESULT_MARKER = "KODY_CAPABILITY_RESULT"

export type CapabilityResultStatus = "pass" | "fail" | "blocked" | "changed" | "noop"

export interface CapabilityResultArtifact {
  label: string
  url?: string
  path?: string
}

export interface CapabilityResult {
  version: 1
  target?: CapabilityReportTarget
  status: CapabilityResultStatus
  resultClass?: GoalEvidenceResultClass
  summary: string
  evidence?: Record<string, boolean>
  facts: Record<string, unknown>
  artifacts: CapabilityResultArtifact[]
  missingEvidence: string[]
  blockers: string[]
}

const RESULT_LINE = /^KODY_(?:CAPABILITY|CAPABILITY)_RESULT=(.+)$/gm
const STATUSES = new Set<CapabilityResultStatus>(["pass", "fail", "blocked", "changed", "noop"])
const CONTROL_FACT_KEYS = new Set(["blockers", "destination", "capabilities", "route", "stage", "state"])

export function parseCapabilityResultsFromText(text: string): CapabilityResult[] {
  const results: CapabilityResult[] = []
  for (const match of text.matchAll(RESULT_LINE)) {
    const raw = match[1]?.trim()
    if (!raw) continue
    try {
      const parsed = parseCapabilityResult(JSON.parse(raw))
      if (parsed) results.push(parsed)
    } catch {
      // Capability results are an optional side channel; malformed lines are ignored.
    }
  }
  return results
}

export function parseCapabilityResult(raw: unknown): CapabilityResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>

  if (obj.version !== 1) return null
  if (!isCapabilityResultStatus(obj.status)) return null

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : ""
  if (!summary) return null

  const target = obj.target === undefined ? undefined : parseCapabilityReportTarget(obj.target)
  if (obj.target !== undefined && !target) return null
  const evidence = obj.evidence === undefined ? undefined : parseCapabilityReportEvidence(obj.evidence)
  if (obj.evidence !== undefined && !evidence) return null

  const facts = parseFacts(obj.facts)
  if (!facts) return null

  const artifacts = parseArtifacts(obj.artifacts)
  if (!artifacts) return null
  const missingEvidence = parseOptionalStringArray(obj.missingEvidence)
  if (!missingEvidence) return null
  const blockers = parseOptionalStringArray(obj.blockers)
  if (!blockers) return null

  return {
    version: 1,
    ...(target ? { target } : {}),
    status: obj.status,
    ...(isGoalEvidenceResultClass(obj.resultClass) ? { resultClass: obj.resultClass } : {}),
    summary,
    ...(evidence ? { evidence } : {}),
    facts,
    artifacts,
    missingEvidence,
    blockers,
  }
}

export function applyCapabilityResultToObjectiveState(
  state: GoalState,
  result: CapabilityResult,
  evidenceOverride?: string,
): GoalState {
  const priorFacts = parseFacts(state.extra.facts) ?? {}
  const nextFacts: Record<string, unknown> = { ...priorFacts }
  for (const [key, value] of Object.entries(result.facts)) {
    if (CONTROL_FACT_KEYS.has(key)) continue
    nextFacts[key] = value
  }
  for (const [key, value] of Object.entries(result.evidence ?? {})) {
    nextFacts[key] = value
  }

  const evidence = evidenceOverride || (typeof nextFacts.pendingEvidence === "string" ? nextFacts.pendingEvidence : "")
  const resultIncludesEvidence = evidence ? Object.hasOwn(result.evidence ?? {}, evidence) : false
  const terminalStatus = result.status === "pass" || result.status === "fail" || result.status === "blocked"
  if (evidence && !resultIncludesEvidence) {
    if (result.status === "pass") nextFacts[evidence] = true
    if (result.status === "fail" || result.status === "blocked") nextFacts[evidence] = false
  }
  if (evidence) {
    if (nextFacts.pendingEvidence === evidence && (resultIncludesEvidence || terminalStatus)) {
      delete nextFacts.pendingEvidence
    }
  }

  const blockers = parseStringArray(state.extra.blockers) ?? []
  const resultBlockers =
    result.blockers.length > 0 || (result.status !== "fail" && result.status !== "blocked")
      ? result.blockers
      : [result.summary]
  for (const blocker of resultBlockers) {
    if (!blockers.includes(blocker)) blockers.push(blocker)
  }

  return {
    ...state,
    extra: {
      ...state.extra,
      facts: nextFacts,
      blockers,
      lastCapabilityResult: {
        target: result.target,
        status: result.status,
        summary: result.summary,
        evidence: result.evidence,
        facts: result.facts,
        artifacts: result.artifacts,
        missingEvidence: result.missingEvidence,
        blockers: result.blockers,
      },
    },
  }
}

function isCapabilityResultStatus(value: unknown): value is CapabilityResultStatus {
  return typeof value === "string" && STATUSES.has(value as CapabilityResultStatus)
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

function parseOptionalStringArray(raw: unknown): string[] | null {
  if (raw === undefined) return []
  return parseStringArray(raw)
}

function parseArtifacts(raw: unknown): CapabilityResultArtifact[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null

  const artifacts: CapabilityResultArtifact[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null
    const rawArtifact = item as Record<string, unknown>
    const label = typeof rawArtifact.label === "string" ? rawArtifact.label.trim() : ""
    const url = typeof rawArtifact.url === "string" ? rawArtifact.url.trim() : ""
    const artifactPath = typeof rawArtifact.path === "string" ? rawArtifact.path.trim() : ""

    if (!label || (!url && !artifactPath)) return null

    artifacts.push({
      label,
      ...(url ? { url } : {}),
      ...(artifactPath ? { path: artifactPath } : {}),
    })
  }
  return artifacts
}
