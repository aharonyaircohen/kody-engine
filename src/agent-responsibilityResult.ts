import type { GoalState } from "./goal/state.js"

export const AGENT_RESPONSIBILITY_RESULT_MARKER = "KODY_AGENT_RESPONSIBILITY_RESULT"

export type AgentResponsibilityResultStatus = "pass" | "fail" | "blocked" | "changed" | "noop"

export interface AgentResponsibilityResultArtifact {
  label: string
  url?: string
  path?: string
}

export interface AgentResponsibilityResult {
  version: 1
  status: AgentResponsibilityResultStatus
  summary: string
  facts: Record<string, unknown>
  artifacts: AgentResponsibilityResultArtifact[]
  missingEvidence: string[]
  blockers: string[]
}

const RESULT_LINE = /^KODY_AGENT_RESPONSIBILITY_RESULT=(.+)$/gm
const STATUSES = new Set<AgentResponsibilityResultStatus>(["pass", "fail", "blocked", "changed", "noop"])
const CONTROL_FACT_KEYS = new Set(["blockers", "destination", "agent-responsibilities", "route", "stage", "state"])

export function parseAgentResponsibilityResultsFromText(text: string): AgentResponsibilityResult[] {
  const results: AgentResponsibilityResult[] = []
  for (const match of text.matchAll(RESULT_LINE)) {
    const raw = match[1]?.trim()
    if (!raw) continue
    try {
      const parsed = parseAgentResponsibilityResult(JSON.parse(raw))
      if (parsed) results.push(parsed)
    } catch {
      // AgentResponsibility results are an optional side channel; malformed lines are ignored.
    }
  }
  return results
}

export function parseAgentResponsibilityResult(raw: unknown): AgentResponsibilityResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>

  if (obj.version !== 1) return null
  if (!isAgentResponsibilityResultStatus(obj.status)) return null

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : ""
  if (!summary) return null

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
    status: obj.status,
    summary,
    facts,
    artifacts,
    missingEvidence,
    blockers,
  }
}

export function applyAgentResponsibilityResultToObjectiveState(
  state: GoalState,
  result: AgentResponsibilityResult,
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
      lastAgentResponsibilityResult: {
        status: result.status,
        summary: result.summary,
        facts: result.facts,
        artifacts: result.artifacts,
        missingEvidence: result.missingEvidence,
        blockers: result.blockers,
      },
    },
  }
}

function isAgentResponsibilityResultStatus(value: unknown): value is AgentResponsibilityResultStatus {
  return typeof value === "string" && STATUSES.has(value as AgentResponsibilityResultStatus)
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

function parseArtifacts(raw: unknown): AgentResponsibilityResultArtifact[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null

  const artifacts: AgentResponsibilityResultArtifact[] = []
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
