import type { GoalState } from "./goal/state.js"

export type DutyReportTargetType = "goal" | "task" | "duty"

export interface DutyReportTarget {
  type: DutyReportTargetType
  id: string
}

export interface DutyReport {
  target: DutyReportTarget
  evidence?: Record<string, boolean>
  facts?: Record<string, unknown>
}

const REPORT_LINE = /^KODY_DUTY_REPORT=(.+)$/gm
const CONTROL_FACT_KEYS = new Set(["blockers", "destination", "duties", "route", "stage", "state"])

export function parseDutyReportsFromText(text: string): DutyReport[] {
  const reports: DutyReport[] = []
  for (const match of text.matchAll(REPORT_LINE)) {
    const raw = match[1]?.trim()
    if (!raw) continue
    try {
      const parsed = parseDutyReport(JSON.parse(raw))
      if (parsed) reports.push(parsed)
    } catch {
      // Report lines are an optional side channel; malformed lines should not
      // turn an otherwise valid duty result into an engine failure.
    }
  }
  return reports
}

export function parseDutyReport(raw: unknown): DutyReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const target = parseTarget(obj.target)
  if (!target) return null

  const evidence = parseBooleanRecord(obj.evidence)
  const facts = parseFacts(obj.facts)
  if (!evidence && !facts) return null

  return {
    target,
    ...(evidence ? { evidence } : {}),
    ...(facts ? { facts } : {}),
  }
}

export function applyDutyReportToGoalState(state: GoalState, report: DutyReport): GoalState {
  const priorFacts = parseFacts(state.extra.facts) ?? {}
  const nextFacts: Record<string, unknown> = { ...priorFacts }

  for (const [key, value] of Object.entries(report.facts ?? {})) {
    if (CONTROL_FACT_KEYS.has(key)) continue
    nextFacts[key] = value
  }
  for (const [key, value] of Object.entries(report.evidence ?? {})) {
    nextFacts[key] = value
  }

  const pending = nextFacts.pendingEvidence
  if (typeof pending === "string" && Object.hasOwn(report.evidence ?? {}, pending)) {
    delete nextFacts.pendingEvidence
  }

  return {
    ...state,
    extra: {
      ...state.extra,
      facts: nextFacts,
    },
  }
}

function parseTarget(raw: unknown): DutyReportTarget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const target = raw as Record<string, unknown>
  if (target.type !== "goal" && target.type !== "task" && target.type !== "duty") return null
  if (typeof target.id !== "string" || target.id.trim().length === 0) return null
  return { type: target.type, id: target.id.trim() }
}

function parseBooleanRecord(raw: unknown): Record<string, boolean> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const out: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0 || typeof value !== "boolean") return null
    out[key] = value
  }
  return out
}

function parseFacts(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) return null
    if (CONTROL_FACT_KEYS.has(key)) continue
    out[key] = value
  }
  return out
}
