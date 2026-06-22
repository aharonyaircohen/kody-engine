import type { GoalState } from "./goal/state.js"

export const DUTY_RESULT_MARKER = "KODY_DUTY_RESULT"

export type DutyResultStatus = "pass" | "fail" | "blocked" | "changed" | "noop"

export interface DutyResultArtifact {
  label: string
  url?: string
  path?: string
}

export interface DutyResult {
  version: 1
  status: DutyResultStatus
  summary: string
  facts: Record<string, unknown>
  artifacts: DutyResultArtifact[]
}

const RESULT_LINE = /^KODY_DUTY_RESULT=(.+)$/gm
const STATUSES = new Set<DutyResultStatus>(["pass", "fail", "blocked", "changed", "noop"])
const CONTROL_FACT_KEYS = new Set(["blockers", "destination", "duties", "route", "stage", "state"])

export function parseDutyResultsFromText(text: string): DutyResult[] {
  const results: DutyResult[] = []
  for (const match of text.matchAll(RESULT_LINE)) {
    const raw = match[1]?.trim()
    if (!raw) continue
    try {
      const parsed = parseDutyResult(JSON.parse(raw))
      if (parsed) results.push(parsed)
    } catch {
      // Duty results are an optional side channel; malformed lines are ignored.
    }
  }
  return results
}

export function parseDutyResult(raw: unknown): DutyResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>

  if (obj.version !== 1) return null
  if (!isDutyResultStatus(obj.status)) return null

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : ""
  if (!summary) return null

  const facts = parseFacts(obj.facts)
  if (!facts) return null

  const artifacts = parseArtifacts(obj.artifacts)
  if (!artifacts) return null

  return {
    version: 1,
    status: obj.status,
    summary,
    facts,
    artifacts,
  }
}

export function applyDutyResultToObjectiveState(
  state: GoalState,
  result: DutyResult,
  evidenceOverride?: string,
): GoalState {
  const priorFacts = parseFacts(state.extra.facts) ?? {}
  const nextFacts: Record<string, unknown> = { ...priorFacts }
  for (const [key, value] of Object.entries(result.facts)) {
    if (CONTROL_FACT_KEYS.has(key)) continue
    nextFacts[key] = value
  }

  const evidence = evidenceOverride || (typeof nextFacts.pendingEvidence === "string" ? nextFacts.pendingEvidence : "")
  if (evidence) {
    if (result.status === "pass") nextFacts[evidence] = true
    if (result.status === "fail" || result.status === "blocked") nextFacts[evidence] = false
    if (
      (result.status === "pass" || result.status === "fail" || result.status === "blocked") &&
      nextFacts.pendingEvidence === evidence
    ) {
      delete nextFacts.pendingEvidence
    }
  }

  const blockers = parseStringArray(state.extra.blockers) ?? []
  if ((result.status === "fail" || result.status === "blocked") && !blockers.includes(result.summary)) {
    blockers.push(result.summary)
  }

  return {
    ...state,
    extra: {
      ...state.extra,
      facts: nextFacts,
      blockers,
      lastDutyResult: {
        status: result.status,
        summary: result.summary,
        facts: result.facts,
        artifacts: result.artifacts,
      },
    },
  }
}

function isDutyResultStatus(value: unknown): value is DutyResultStatus {
  return typeof value === "string" && STATUSES.has(value as DutyResultStatus)
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

function parseArtifacts(raw: unknown): DutyResultArtifact[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null

  const artifacts: DutyResultArtifact[] = []
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
