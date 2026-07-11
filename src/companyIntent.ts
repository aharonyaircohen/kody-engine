import { type GoalState, nowIso } from "./goal/state.js"
import { fetchGoalState, listGoalStateIds, putGoalState } from "./goal/stateStore.js"
import {
  appendStateLine,
  listStateDirectory,
  readStateText,
  type StateRepoConfig,
  upsertStateText,
} from "./stateRepo.js"

export type CompanyIntentStatus = "active" | "paused" | "archived"
export type CompanyIntentPosture = "confidence" | "speed" | "stability-recovery" | "maintenance" | "balanced"

export interface CompanyIntent {
  version: 1
  id: string
  status: CompanyIntentStatus
  for: string
  description?: string
  priority: number
  posture: CompanyIntentPosture
  scope: {
    repos: string[]
    areas: string[]
  }
  principles: string[]
  metrics: string[]
  policy: {
    release?: {
      cadence?: "manual" | "1d" | "1w"
      qaDepth?: "light" | "standard" | "strict"
      blockerLevel?: "low" | "standard" | "strict"
      approval?: "none" | "before-production" | "before-risky-actions"
    }
    automation: {
      authority: "full-auto"
      maxConcurrentGoals: number
      maxDailyActions: number
      requiresHumanFor: string[]
    }
  }
  portfolio: {
    goals: string[]
    loops: string[]
    capabilities: string[]
  }
  createdAt: string
  updatedAt: string
}

export interface CompanyIntentRecord {
  id: string
  path: string
  intent: CompanyIntent
}

export interface CompanyPortfolioGoal {
  id: string
  state: GoalState["state"]
  type?: string
  outcome?: string
  capabilities: string[]
  isLoop: boolean
  updatedAt?: string
}

export interface CompanyPortfolio {
  goals: CompanyPortfolioGoal[]
}

export interface CompanyIntentDecisionLog {
  at: string
  agent: string
  intentId?: string
  action: string
  reason: string
  before?: unknown
  after?: unknown
  resources?: string[]
}

const SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/

export function isCompanyIntentId(value: string): boolean {
  return SLUG_RE.test(value)
}

export function companyIntentPath(id: string): string {
  assertIntentId(id)
  return `intents/${id}/intent.json`
}

export function normalizeCompanyIntent(path: string, raw: unknown): CompanyIntent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: intent must be JSON object`)
  }
  const input = raw as Record<string, unknown>
  const id = stringField(input.id)
  if (!id || !isCompanyIntentId(id)) throw new Error(`${path}: invalid intent id`)

  const createdAt = stringField(input.createdAt) || nowIso()
  const updatedAt = stringField(input.updatedAt) || createdAt
  const description = stringField(input.description)

  return {
    version: 1,
    id,
    status: oneOf(input.status, ["active", "paused", "archived"] as const, "active"),
    for: stringField(input.for),
    ...(description ? { description } : {}),
    priority: numberField(input.priority, 100),
    posture: oneOf(
      input.posture,
      ["confidence", "speed", "stability-recovery", "maintenance", "balanced"] as const,
      "balanced",
    ),
    scope: {
      repos: stringArray(recordField(input.scope)?.repos),
      areas: stringArray(recordField(input.scope)?.areas),
    },
    principles: stringArray(input.principles),
    metrics: stringArray(input.metrics),
    policy: {
      release: normalizeReleasePolicy(recordField(recordField(input.policy)?.release)),
      automation: normalizeAutomationPolicy(recordField(recordField(input.policy)?.automation)),
    },
    portfolio: {
      goals: stringArray(recordField(input.portfolio)?.goals).filter(isCompanyIntentId),
      loops: stringArray(recordField(input.portfolio)?.loops).filter(isCompanyIntentId),
      capabilities: stringArray(recordField(input.portfolio)?.capabilities).filter(isCompanyIntentId),
    },
    createdAt,
    updatedAt,
  }
}

export function listCompanyIntents(config: StateRepoConfig, cwd?: string): CompanyIntentRecord[] {
  const entries = listStateDirectory(config, cwd, "intents")
  const records: CompanyIntentRecord[] = []
  for (const entry of entries) {
    if (entry.type !== "dir" || !entry.name || !isCompanyIntentId(entry.name)) continue
    const path = companyIntentPath(entry.name)
    const file = readStateText(config, cwd, path)
    if (!file) continue
    records.push({
      id: entry.name,
      path: file.path,
      intent: normalizeCompanyIntent(file.path, JSON.parse(file.content)),
    })
  }
  return records.sort((a, b) => a.intent.priority - b.intent.priority || a.id.localeCompare(b.id))
}

export function readCompanyIntent(
  config: StateRepoConfig,
  cwd: string | undefined,
  id: string,
): CompanyIntentRecord | null {
  const path = companyIntentPath(id)
  const file = readStateText(config, cwd, path)
  if (!file) return null
  return { id, path: file.path, intent: normalizeCompanyIntent(file.path, JSON.parse(file.content)) }
}

export function writeCompanyIntent(
  config: StateRepoConfig,
  cwd: string | undefined,
  intent: CompanyIntent,
  message = `chore(intents): update ${intent.id}`,
): void {
  upsertStateText(config, cwd, companyIntentPath(intent.id), `${JSON.stringify(intent, null, 2)}\n`, message)
}

export function appendCompanyIntentDecision(
  config: StateRepoConfig,
  cwd: string | undefined,
  intentId: string,
  entry: CompanyIntentDecisionLog,
): void {
  assertIntentId(intentId)
  appendStateLine(
    config,
    cwd,
    `intents/${intentId}/decisions.jsonl`,
    JSON.stringify(entry),
    `chore(intents): log ${intentId} decision`,
  )
}

export function listCompanyPortfolio(config: StateRepoConfig, cwd?: string): CompanyPortfolio {
  const goals: CompanyPortfolioGoal[] = []
  for (const id of listGoalStateIds(config, cwd)) {
    if (!isCompanyIntentId(id)) continue
    const state = fetchGoalState(config, id, cwd)
    if (!state) continue
    const destination = recordField(state.extra.destination)
    goals.push({
      id,
      state: state.state,
      type: stringField(state.extra.type) || undefined,
      outcome: stringField(destination?.outcome) || undefined,
      capabilities: stringArray(state.extra.capabilities),
      isLoop: state.extra.scheduleMode === "agentLoop" || state.extra.type === "agentLoop",
      updatedAt: state.updatedAt,
    })
  }
  return { goals: goals.sort((a, b) => a.id.localeCompare(b.id)) }
}

export function writeCompanyGoalState(
  config: StateRepoConfig,
  cwd: string | undefined,
  id: string,
  state: GoalState,
  message: string,
): void {
  assertIntentId(id)
  putGoalState(config, id, state, message, cwd)
}

function assertIntentId(id: string): void {
  if (!isCompanyIntentId(id)) throw new Error(`invalid intent/portfolio id: ${id}`)
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function recordField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T[number]) : fallback
}

function normalizeReleasePolicy(raw: Record<string, unknown> | null): CompanyIntent["policy"]["release"] {
  if (!raw) return undefined
  return {
    cadence: oneOf(raw.cadence, ["manual", "1d", "1w"] as const, "manual"),
    qaDepth: oneOf(raw.qaDepth, ["light", "standard", "strict"] as const, "standard"),
    blockerLevel: oneOf(raw.blockerLevel, ["low", "standard", "strict"] as const, "standard"),
    approval: oneOf(
      raw.approval,
      ["none", "before-production", "before-risky-actions"] as const,
      "before-risky-actions",
    ),
  }
}

function normalizeAutomationPolicy(raw: Record<string, unknown> | null): CompanyIntent["policy"]["automation"] {
  return {
    authority: "full-auto",
    maxConcurrentGoals: Math.max(1, Math.floor(numberField(raw?.maxConcurrentGoals, 1))),
    maxDailyActions: Math.max(1, Math.floor(numberField(raw?.maxDailyActions, 6))),
    requiresHumanFor: stringArray(raw?.requiresHumanFor),
  }
}
