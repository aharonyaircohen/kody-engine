import type { Profile } from "./implementations/types.js"
import { createStateBackendFromEnv } from "./state-backend.js"

interface RunBackendConfig {
  github?: { owner?: string; repo?: string }
}

export type RunIndexSubjectType = "goal" | "loop" | "workflow" | "capability"
export type RunIndexStatus = "running" | "waiting" | "success" | "failed" | "blocked" | "cancelled" | "recorded"

export interface RunIndexRow {
  version: 1
  id: string
  subjectType: RunIndexSubjectType
  subjectId: string
  subjectLabel?: string
  subjectModel?: string
  status: RunIndexStatus
  title: string
  summary?: string
  currentStep?: string
  decision?: string
  startedAt?: string
  updatedAt: string
  kodyRunId?: string
  githubRunId?: string
  githubRunAttempt?: string
  githubRunUrl?: string
  triggerKind?: string
  triggerMode?: "manual" | "scheduled" | "event" | "local"
  actor?: string
  action?: string
  capability?: string
  workflow?: string
  implementation?: string
  parentRunId?: string
  capabilityRevision?: string
  implementationRevision?: string
  agent?: string
  model?: string
  modelProvider?: string
  modelName?: string
  reasoningEffort?: string
  target?: unknown
  sourceType?: "job" | "goal-run-log"
  sourcePath?: string
  detailUrl?: string
  statePath?: string
}

export interface RunIndexFile {
  version: 1
  updatedAt: string
  runs: RunIndexRow[]
}

const RUN_INDEX_PATH = "runs/index.json"
const MAX_RUNS = 200
const STAGED_RUN_INDEX_ROWS_KEY = "__stagedRunIndexRows"

export function runIndexPath(): string {
  return RUN_INDEX_PATH
}

export async function upsertRunIndexRowBestEffortAsync(
  config: RunBackendConfig,
  _cwd: string | undefined,
  row: RunIndexRow | null,
): Promise<void> {
  if (!row) return
  const tenantId = tenantIdForRun(config)
  if (!tenantId) throw new Error("Repository identity is required for the run index")
  await createStateBackendFromEnv().saveAgencyRun(tenantId, row.id, row.subjectType, row.subjectId, row, row.updatedAt)
}

export function stageRunIndexFinalization(data: Record<string, unknown>, row: RunIndexRow | null): void {
  if (!row) return
  const rows = stagedRunIndexRows(data)
  rows[row.id] = row
}

export async function finalizeStagedRunIndexRowsAsync(
  config: RunBackendConfig,
  cwd: string | undefined,
  data: Record<string, unknown>,
  result: { status: RunIndexStatus; updatedAt: string; reason?: string },
): Promise<void> {
  const rows = stagedRunIndexRows(data)
  for (const row of Object.values(rows)) {
    await upsertRunIndexRowBestEffortAsync(config, cwd, finalizedRunIndexRow(row, result))
  }
  data[STAGED_RUN_INDEX_ROWS_KEY] = {}
}

function finalizedRunIndexRow(
  row: RunIndexRow,
  result: { status: RunIndexStatus; updatedAt: string; reason?: string },
): RunIndexRow {
  const target = recordValue(row.target)
  const targetType = stringValue(target?.type)
  const targetId = stringValue(target?.id)
  if (
    row.sourceType === "goal-run-log" &&
    row.subjectType === "loop" &&
    targetType === "goal" &&
    targetId &&
    result.status === "success"
  ) {
    return {
      ...row,
      status: "waiting",
      updatedAt: result.updatedAt,
      summary: `waiting on goal ${targetId}`,
      currentStep: targetId,
    }
  }
  return {
    ...row,
    status: result.status,
    updatedAt: result.updatedAt,
    summary: result.reason ?? row.summary,
  }
}

export function mergeRunIndexRow(raw: string | undefined | null, row: RunIndexRow): RunIndexFile {
  const parsed = parseRunIndex(raw)
  const runs = [row, ...parsed.runs.filter((existing) => existing.id !== row.id)].slice(0, MAX_RUNS)
  return {
    version: 1,
    updatedAt: row.updatedAt,
    runs,
  }
}

export function runIndexRowFromJobContext(input: {
  data: Record<string, unknown>
  profileName: string
  profile: Pick<Profile, "name" | "describe" | "agent">
  status: RunIndexStatus
  startedAt: string
  updatedAt: string
  reason?: string
}): RunIndexRow | null {
  const subjectType = runSubjectType(input.data)
  const subjectId = stringValue(input.data.runSubjectId)
  if (!subjectType || !subjectId) return null

  const kodyRunId = stringValue(input.data.jobId) ?? `${input.profileName}-${Date.now()}`
  const workflow = stringValue(input.data.runSubjectWorkflow) ?? stringValue(input.data.workflowCapability)
  const title = stringValue(input.data.runSubjectLabel) ?? subjectId
  const githubRunId = process.env.GITHUB_RUN_ID?.trim() || undefined
  const githubRunAttempt = process.env.GITHUB_RUN_ATTEMPT?.trim() || undefined
  const githubRepository = process.env.GITHUB_REPOSITORY?.trim()
  const githubServer = process.env.GITHUB_SERVER_URL?.trim() || "https://github.com"
  const triggerKind = triggerKindFromEnv()

  return pruneUndefined({
    version: 1 as const,
    id: `${subjectType}:${subjectId}:${kodyRunId}`,
    subjectType,
    subjectId,
    subjectLabel: title,
    subjectModel: stringValue(input.data.runSubjectModel) ?? undefined,
    status: input.status,
    title,
    summary: input.reason ?? stringValue(input.data.workflowStepReason) ?? input.profile.describe,
    currentStep: stringValue(input.data.workflowStep) ?? input.profileName,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    kodyRunId,
    githubRunId,
    githubRunAttempt,
    githubRunUrl:
      githubRunId && githubRepository ? `${githubServer}/${githubRepository}/actions/runs/${githubRunId}` : undefined,
    triggerKind,
    triggerMode: triggerMode(triggerKind),
    actor: process.env.GITHUB_ACTOR?.trim() || undefined,
    action: stringValue(input.data.jobAction) ?? undefined,
    capability: stringValue(input.data.jobCapability) ?? undefined,
    workflow: workflow ?? undefined,
    implementation: stringValue(input.data.selectedImplementation) ?? input.profileName,
    parentRunId: stringValue(input.data.parentRunId) ?? undefined,
    capabilityRevision: stringValue(input.data.capabilityRevision) ?? undefined,
    implementationRevision: stringValue(input.data.implementationRevision) ?? undefined,
    agent: stringValue(input.data.jobAgent) ?? input.profile.agent ?? undefined,
    model: stringValue(input.data.jobModel) ?? undefined,
    modelProvider: stringValue(input.data.jobModelProvider) ?? undefined,
    modelName: stringValue(input.data.jobModelName) ?? undefined,
    reasoningEffort: stringValue(input.data.jobReasoningEffort) ?? undefined,
    target: input.data.jobTarget,
    sourceType: "job" as const,
  })
}

export function runIndexRowFromGoalEvents(
  goalId: string,
  logPath: string,
  events: Record<string, unknown>[],
): RunIndexRow | null {
  if (events.length === 0) return null
  const first = events[0]!
  const last = events[events.length - 1]!
  const goal = recordValue(last.goal) ?? recordValue(first.goal)
  const goalType = stringValue(last.goalType) ?? stringValue(first.goalType) ?? stringValue(goal?.type)
  const subjectType: RunIndexSubjectType = goalType === "agentLoop" ? "loop" : "goal"
  const run = recordValue(first.run) ?? recordValue(last.run)
  const job = recordValue(last.job) ?? recordValue(first.job)
  const trigger = recordValue(last.trigger) ?? recordValue(first.trigger)
  const links = recordValue(last.links) ?? recordValue(first.links)
  const decision = recordValue(last.decision)
  const trace = recordValue(last.trace)
  const traceResult = recordValue(trace?.result)
  const kodyRunId = stringValue(run?.id) ?? stringValue(job?.id) ?? logPath
  const updatedAt = stringValue(last.time) ?? new Date().toISOString()

  return pruneUndefined({
    version: 1 as const,
    id: `${subjectType}:${goalId}:${kodyRunId}`,
    subjectType,
    subjectId: goalId,
    subjectLabel: goalId,
    subjectModel: goalType ?? undefined,
    status: statusFromGoalEvent(last, decision),
    title: goalId,
    summary:
      stringValue(last.summary) ??
      stringValue(last.reason) ??
      stringValue(traceResult?.summary) ??
      stringValue(last.event) ??
      undefined,
    currentStep: stringValue(last.stage) ?? stringValue(goal?.stage) ?? stringValue(last.event) ?? undefined,
    decision:
      [stringValue(decision?.kind), stringValue(decision?.reason) ?? stringValue(last.reason)]
        .filter(Boolean)
        .join(" - ") || undefined,
    startedAt: stringValue(first.time) ?? undefined,
    updatedAt,
    kodyRunId,
    githubRunId: stringValue(run?.githubRunId) ?? undefined,
    githubRunAttempt: stringValue(run?.githubRunAttempt) ?? undefined,
    githubRunUrl: stringValue(links?.workflowRun) ?? stringValue(run?.url) ?? undefined,
    triggerKind: stringValue(trigger?.kind) ?? undefined,
    triggerMode: triggerMode(stringValue(trigger?.kind)),
    actor: stringValue(trigger?.githubActor) ?? stringValue(trigger?.actor) ?? undefined,
    action: stringValue(job?.action) ?? undefined,
    capability: stringValue(job?.capability) ?? undefined,
    implementation: stringValue(job?.implementation) ?? undefined,
    agent: stringValue(job?.agent) ?? undefined,
    model: stringValue(job?.model) ?? undefined,
    modelProvider: stringValue(job?.modelProvider) ?? undefined,
    modelName: stringValue(job?.modelName) ?? undefined,
    reasoningEffort: stringValue(job?.reasoningEffort) ?? undefined,
    target: last.target,
    sourceType: "goal-run-log" as const,
    sourcePath: logPath,
    detailUrl: stringValue(links?.log) ?? undefined,
  })
}

export function statusFromExitCode(exitCode: number): RunIndexStatus {
  return exitCode === 0 ? "success" : "failed"
}

function parseRunIndex(raw: string | undefined | null): RunIndexFile {
  if (!raw) return { version: 1, updatedAt: new Date().toISOString(), runs: [] }
  try {
    const parsed = JSON.parse(raw) as unknown
    const record = recordValue(parsed)
    const runs = Array.isArray(record?.runs) ? record.runs.filter(isRunIndexRow).map(normalizeRunIndexRow) : []
    return { version: 1, updatedAt: stringValue(record?.updatedAt) ?? new Date().toISOString(), runs }
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), runs: [] }
  }
}

function isRunIndexRow(value: unknown): value is RunIndexRow {
  const record = recordValue(value)
  return (
    record?.version === 1 &&
    isRunSubjectType(record.subjectType) &&
    typeof record.subjectId === "string" &&
    typeof record.id === "string" &&
    typeof record.status === "string" &&
    typeof record.title === "string" &&
    typeof record.updatedAt === "string"
  )
}

function isRunSubjectType(value: unknown): value is RunIndexSubjectType {
  return value === "goal" || value === "loop" || value === "workflow" || value === "capability"
}

function stagedRunIndexRows(data: Record<string, unknown>): Record<string, RunIndexRow> {
  const value = data[STAGED_RUN_INDEX_ROWS_KEY]
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, RunIndexRow>
  }
  const rows: Record<string, RunIndexRow> = {}
  data[STAGED_RUN_INDEX_ROWS_KEY] = rows
  return rows
}

function normalizeRunIndexRow(row: RunIndexRow): RunIndexRow {
  return row
}

function runSubjectType(data: Record<string, unknown>): RunIndexSubjectType | null {
  const value = data.runSubjectType
  return isRunSubjectType(value) ? value : null
}

function statusFromGoalEvent(event: Record<string, unknown>, decision: Record<string, unknown> | null): RunIndexStatus {
  const status = stringValue(event.status)?.toLowerCase()
  const eventName = stringValue(event.event)?.toLowerCase() ?? ""
  const decisionKind = stringValue(decision?.kind)?.toLowerCase()
  if (status === "success" || status === "completed" || decisionKind === "done") return "success"
  if (status === "failure" || status === "failed" || eventName.includes("fail")) return "failed"
  if (status === "cancelled") return "cancelled"
  if (decisionKind === "blocked") return "blocked"
  if (status === "idle" || decisionKind === "idle" || eventName.includes(".idle")) return "waiting"
  if (status === "running" || status === "dispatch" || decisionKind === "dispatch" || eventName.includes("dispatch"))
    return "running"
  return "recorded"
}

function triggerKindFromEnv(): string | undefined {
  const eventName = process.env.GITHUB_EVENT_NAME?.trim()
  if (!eventName) return undefined
  if (eventName === "schedule") return "schedule"
  if (eventName === "workflow_dispatch") return "manual-workflow-dispatch"
  return eventName
}

function triggerMode(kind: string | null | undefined): RunIndexRow["triggerMode"] | undefined {
  if (!kind) return undefined
  if (kind === "schedule") return "scheduled"
  if (kind === "manual-workflow-dispatch") return "manual"
  if (kind === "local") return "local"
  return "event"
}

function tenantIdForRun(config: RunBackendConfig): string | undefined {
  if (config.github?.owner && config.github.repo) return `${config.github.owner}/${config.github.repo}`
  return process.env.GITHUB_REPOSITORY?.trim() || undefined
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function pruneUndefined<T extends Record<string, unknown>>(input: T): T {
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) delete input[key]
  }
  return input
}
