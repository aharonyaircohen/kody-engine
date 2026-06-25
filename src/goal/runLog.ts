import type { AgentResponsibilityResultArtifact } from "../agent-responsibilityResult.js"
import { appendStateLine, type StateRepoConfig } from "../stateRepo.js"
import { nowIso } from "./state.js"

export interface GoalRunLogDispatch {
  action?: string
  agentResponsibility?: string
  agentAction?: string
  cliArgs?: Record<string, unknown>
}

export interface GoalRunLogEvent {
  version: 1
  time: string
  source: "goal-manager" | "goal-report"
  event: string
  goalId: string
  goalType?: string
  goalState?: string
  stage?: string
  evidence?: string
  status?: string
  reason?: string
  dispatch?: GoalRunLogDispatch
  target?: { type: string; id: string }
  facts?: Record<string, unknown>
  evidenceValues?: Record<string, boolean>
  artifacts?: AgentResponsibilityResultArtifact[]
}

interface GoalRunLogBuffer {
  path: string
  events: GoalRunLogEvent[]
}

const LOGS_KEY = "__goalRunLogs"
const LOG_RUN_KEY = "__goalRunLogRunId"
const LOG_STARTED_KEY = "__goalRunLogStartedAt"

export function stageGoalRunLogEvent(
  data: Record<string, unknown>,
  goalId: string,
  event: Omit<GoalRunLogEvent, "version" | "time" | "goalId">,
  at = nowIso(),
): void {
  const logs = goalRunLogs(data)
  const existing = logs[goalId]
  const path = existing?.path ?? goalRunLogPath(goalId, data)
  logs[goalId] = {
    path,
    events: [
      ...(existing?.events ?? []),
      {
        version: 1,
        time: at,
        goalId,
        ...event,
      },
    ],
  }
}

export function flushGoalRunLogEvents(
  config: StateRepoConfig,
  cwd: string | undefined,
  data: Record<string, unknown>,
): void {
  const logs = goalRunLogs(data)
  for (const [goalId, log] of Object.entries(logs)) {
    if (log.events.length === 0) continue
    const lines = `${log.events.map((event) => JSON.stringify(event)).join("\n")}\n`
    appendStateLine(config, cwd, log.path, lines, `chore(goal-logs): append ${goalId}`)
    log.events = []
  }
}

export function goalRunLogPath(goalId: string, data: Record<string, unknown>): string {
  const startedAt = goalRunStartedAt(data)
  const runId = goalRunId(data)
  return `logs/goals/${safePathSegment(goalId)}/runs/${startedAt}-${runId}.jsonl`
}

function goalRunLogs(data: Record<string, unknown>): Record<string, GoalRunLogBuffer> {
  const existing = data[LOGS_KEY]
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, GoalRunLogBuffer>
  }
  const logs: Record<string, GoalRunLogBuffer> = {}
  data[LOGS_KEY] = logs
  return logs
}

function goalRunStartedAt(data: Record<string, unknown>): string {
  const existing = data[LOG_STARTED_KEY]
  if (typeof existing === "string" && existing.length > 0) return existing
  const stamp = nowIso().replace(/[:.]/g, "-")
  data[LOG_STARTED_KEY] = stamp
  return stamp
}

function goalRunId(data: Record<string, unknown>): string {
  const existing = data[LOG_RUN_KEY]
  if (typeof existing === "string" && existing.length > 0) return existing

  const raw = stringValue(data.jobId) ?? githubRunId() ?? `local-${process.pid}-${Date.now()}`
  const safe = safePathSegment(raw)
  data[LOG_RUN_KEY] = safe
  return safe
}

function githubRunId(): string | null {
  const runId = process.env.GITHUB_RUN_ID?.trim()
  if (!runId) return null
  const attempt = process.env.GITHUB_RUN_ATTEMPT?.trim()
  return attempt ? `gh-${runId}-${attempt}` : `gh-${runId}`
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function safePathSegment(value: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return safe || "unknown"
}
