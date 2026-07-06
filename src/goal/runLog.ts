import * as fs from "node:fs"
import type { CapabilityResultArtifact } from "../capabilityResult.js"
import { runIndexRowFromGoalEvents, stageRunIndexFinalization, upsertRunIndexRowBestEffort } from "../runIndex.js"
import { appendStateLine, parseStateRepoSlug, resolveStateRepoConfig, type StateRepoConfig } from "../stateRepo.js"
import type { GoalRouteStep, ManagedGoal } from "./manager.js"
import { nowIso } from "./state.js"

export interface GoalRunLogDispatch {
  action?: string
  capability?: string
  workflow?: string
  implementation?: string
  cliArgs?: Record<string, unknown>
}

export interface GoalRunLogEvent {
  version: 1
  time: string
  source: "goal-manager" | "goal-loop"
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
  artifacts?: CapabilityResultArtifact[]
  goal?: Record<string, unknown>
  inspection?: Record<string, unknown>
  decision?: Record<string, unknown>
  dispatchContext?: Record<string, unknown>
  change?: Record<string, unknown>
  run?: Record<string, unknown>
  repo?: Record<string, unknown>
  stateRepo?: Record<string, unknown>
  trigger?: Record<string, unknown>
  job?: Record<string, unknown>
  links?: Record<string, unknown>
  trace?: GoalRunTrace
}

export interface GoalRunTrace {
  version: 1
  runId?: string
  workflowRunId?: string
  triggerKind?: string
  source: GoalRunLogEvent["source"]
  event: string
  goal: {
    id: string
    type?: string
    state?: string
    stage?: string
  }
  evidence?: {
    current?: string
    required?: string[]
    satisfied?: string[]
    missing?: string[]
    pending?: string
    values?: Record<string, boolean>
  }
  capability?: GoalRunLogDispatch
  result?: {
    status?: string
    summary?: string
    blockers?: string[]
    artifacts?: CapabilityResultArtifact[]
  }
  change?: Record<string, unknown>
  links?: Record<string, unknown>
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
    events: [...(existing?.events ?? []), buildGoalRunLogEvent(data, goalId, event, at)],
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
    const enrichedEvents = log.events.map((event) => enrichGoalRunLogEvent(config, data, log.path, event))
    const lines = `${enrichedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`
    appendStateLine(config, cwd, log.path, lines, `chore(goal-logs): append ${goalId}`)
    const row = runIndexRowFromGoalEvents(goalId, log.path, enrichedEvents as unknown as Record<string, unknown>[])
    upsertRunIndexRowBestEffort(config, cwd, row)
    stageRunIndexFinalization(data, row)
    log.events = []
  }
}

export function goalRunLogPath(goalId: string, data: Record<string, unknown>): string {
  const startedAt = goalRunStartedAt(data)
  const runId = goalRunId(data)
  return `logs/goals/${safePathSegment(goalId)}/runs/${startedAt}-${runId}.jsonl`
}

export function goalStateLogPath(goalId: string): string {
  return `todos/${safePathSegment(goalId)}.json`
}

export function goalRunLogSnapshot(goalId: string, goalState: string, goal: ManagedGoal): Record<string, unknown> {
  const requiredEvidence = [...goal.destination.evidence]
  const pendingEvidence = typeof goal.facts.pendingEvidence === "string" ? goal.facts.pendingEvidence : undefined
  return {
    id: goalId,
    type: goal.type,
    state: goalState,
    stage: goal.stage,
    outcome: goal.destination.outcome,
    requiredEvidence,
    satisfiedEvidence: requiredEvidence.filter((evidence) => goal.facts[evidence] === true),
    failedEvidence: requiredEvidence.filter((evidence) => goal.facts[evidence] === false),
    missingEvidence: requiredEvidence.filter((evidence) => goal.facts[evidence] !== true),
    pendingEvidence,
    capabilities: [...goal.capabilities],
    route: goal.route.map(routeStepForLog),
    workflowRef: goal.workflowRef,
    schedule: goal.schedule,
    preferredRunTime: goal.preferredRunTime,
    loopTarget: goal.loopTarget,
    blockers: [...goal.blockers],
    facts: { ...goal.facts },
    evidenceState: { ...(goal.evidenceState ?? {}) },
  }
}

export function goalRunLogChange(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!before || !after) return undefined
  const change: Record<string, unknown> = {}

  addScalarChange(change, "state", before.state, after.state)
  addScalarChange(change, "stage", before.stage, after.stage)
  addScalarChange(change, "pendingEvidence", before.pendingEvidence, after.pendingEvidence)

  const beforeFacts = recordValue(before.facts)
  const afterFacts = recordValue(after.facts)
  if (beforeFacts || afterFacts) change.facts = diffRecordKeys(beforeFacts ?? {}, afterFacts ?? {})

  const beforeBlockers = stringArrayValue(before.blockers)
  const afterBlockers = stringArrayValue(after.blockers)
  if (beforeBlockers || afterBlockers) {
    const blockers = diffStringArrays(beforeBlockers ?? [], afterBlockers ?? [])
    if (blockers.added.length > 0 || blockers.removed.length > 0) change.blockers = blockers
  }

  const beforeSatisfied = stringArrayValue(before.satisfiedEvidence)
  const afterSatisfied = stringArrayValue(after.satisfiedEvidence)
  if (beforeSatisfied || afterSatisfied) {
    const evidence = diffStringArrays(beforeSatisfied ?? [], afterSatisfied ?? [])
    if (evidence.added.length > 0 || evidence.removed.length > 0) change.satisfiedEvidence = evidence
  }

  const beforeEvidenceState = recordValue(before.evidenceState)
  const afterEvidenceState = recordValue(after.evidenceState)
  if (beforeEvidenceState || afterEvidenceState) {
    change.evidenceState = diffRecordKeys(beforeEvidenceState ?? {}, afterEvidenceState ?? {})
  }

  return Object.keys(change).length > 0 ? change : undefined
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

function buildGoalRunLogEvent(
  data: Record<string, unknown>,
  goalId: string,
  event: Omit<GoalRunLogEvent, "version" | "time" | "goalId">,
  at: string,
): GoalRunLogEvent {
  const trigger = event.trigger ?? triggerContext()
  const job = event.job ?? jobContext(data)
  const base: GoalRunLogEvent = {
    version: 1,
    time: at,
    goalId,
    ...event,
  }
  if (trigger !== undefined) base.trigger = trigger
  if (job !== undefined) base.job = job
  const context = event.dispatchContext ?? dispatchContext(base, trigger, job)
  if (context !== undefined) base.dispatchContext = context
  return base
}

function enrichGoalRunLogEvent(
  config: StateRepoConfig,
  data: Record<string, unknown>,
  logPath: string,
  event: GoalRunLogEvent,
): GoalRunLogEvent {
  const stateRepo = stateRepoContext(config, event.goalId, logPath)
  const trigger = event.trigger ?? triggerContext()
  const job = event.job ?? jobContext(data)
  const run = event.run ?? runContext(data)
  const links = event.links ?? linkContext(stateRepo)
  const enriched = pruneUndefined({
    ...event,
    run,
    repo: event.repo ?? repoContext(config),
    stateRepo: event.stateRepo ?? stateRepo,
    trigger,
    job,
    dispatchContext: event.dispatchContext ?? dispatchContext(event, trigger, job),
    links,
  }) as GoalRunLogEvent
  enriched.trace = event.trace ?? goalRunTrace(enriched)
  return enriched
}

export function goalRunTrace(event: GoalRunLogEvent): GoalRunTrace {
  const run = recordValue(event.run)
  const trigger = recordValue(event.trigger)
  const goal = recordValue(event.goal)
  const inspection = recordValue(event.inspection)
  const capabilityOutput = recordValue(inspection?.capabilityOutput)
  return pruneUndefined({
    version: 1,
    runId: stringValue(run?.id) ?? undefined,
    workflowRunId: stringValue(run?.githubRunId) ?? undefined,
    triggerKind: stringValue(trigger?.kind) ?? undefined,
    source: event.source,
    event: event.event,
    goal: pruneUndefined({
      id: event.goalId,
      type: event.goalType ?? stringValue(goal?.type) ?? undefined,
      state: event.goalState ?? stringValue(goal?.state) ?? undefined,
      stage: event.stage ?? stringValue(goal?.stage) ?? undefined,
    }),
    evidence: goalTraceEvidence(event, goal, inspection),
    capability: event.dispatch ?? capabilityDispatchFromOutput(capabilityOutput),
    result: goalTraceResult(event, capabilityOutput),
    change: event.change,
    links: event.links,
  }) as GoalRunTrace
}

function goalTraceEvidence(
  event: GoalRunLogEvent,
  goal: Record<string, unknown> | null,
  inspection: Record<string, unknown> | null,
): GoalRunTrace["evidence"] | undefined {
  const expectedEvidence = recordValue(inspection?.expectedEvidence)
  const out = pruneUndefined({
    current: event.evidence,
    required: stringArrayValue(goal?.requiredEvidence) ?? stringArrayValue(inspection?.requiredEvidence) ?? undefined,
    satisfied:
      stringArrayValue(goal?.satisfiedEvidence) ?? stringArrayValue(inspection?.satisfiedEvidence) ?? undefined,
    missing:
      stringArrayValue(goal?.missingEvidence) ??
      stringArrayValue(inspection?.missingEvidence) ??
      stringArrayValue(expectedEvidence?.missingBefore) ??
      undefined,
    pending:
      stringValue(goal?.pendingEvidence) ??
      stringValue(inspection?.pendingEvidence) ??
      stringValue(expectedEvidence?.pendingBefore) ??
      undefined,
    values: event.evidenceValues,
  })
  return Object.keys(out).length > 0 ? out : undefined
}

function capabilityDispatchFromOutput(output: Record<string, unknown> | null): GoalRunLogDispatch | undefined {
  if (!output) return undefined
  const dispatch = pruneUndefined({
    capability: stringValue(output.capability) ?? undefined,
    implementation: stringValue(output.implementation) ?? undefined,
    action: stringValue(output.action) ?? undefined,
  })
  return Object.keys(dispatch).length > 0 ? dispatch : undefined
}

function goalTraceResult(
  event: GoalRunLogEvent,
  capabilityOutput: Record<string, unknown> | null,
): GoalRunTrace["result"] | undefined {
  const result = pruneUndefined({
    status: event.status ?? stringValue(capabilityOutput?.status) ?? undefined,
    summary: event.reason ?? stringValue(capabilityOutput?.summary) ?? undefined,
    blockers: event.inspection ? (stringArrayValue(capabilityOutput?.blockers) ?? undefined) : undefined,
    artifacts: event.artifacts,
  })
  return Object.keys(result).length > 0 ? result : undefined
}

function runContext(data: Record<string, unknown>): Record<string, unknown> {
  const runId = process.env.GITHUB_RUN_ID?.trim()
  const attempt = process.env.GITHUB_RUN_ATTEMPT?.trim()
  const repository = process.env.GITHUB_REPOSITORY?.trim()
  const server = process.env.GITHUB_SERVER_URL?.trim() || "https://github.com"
  return pruneUndefined({
    id: goalRunId(data),
    provider: runId ? "github-actions" : "local",
    githubRunId: runId || undefined,
    githubRunAttempt: attempt || undefined,
    workflow: process.env.GITHUB_WORKFLOW?.trim() || undefined,
    job: process.env.GITHUB_JOB?.trim() || undefined,
    url: runId && repository ? `${server}/${repository}/actions/runs/${runId}` : undefined,
    startedAt: data[LOG_STARTED_KEY],
  })
}

function repoContext(config: StateRepoConfig): Record<string, unknown> {
  const owner = config.github?.owner
  const repo = config.github?.repo
  return pruneUndefined({
    owner,
    repo,
    fullName: owner && repo ? `${owner}/${repo}` : process.env.GITHUB_REPOSITORY?.trim() || undefined,
    ref: process.env.GITHUB_REF?.trim() || undefined,
    sha: process.env.GITHUB_SHA?.trim() || undefined,
  })
}

function stateRepoContext(
  config: StateRepoConfig,
  goalId: string,
  logPath: string,
): Record<string, unknown> | undefined {
  try {
    const state = resolveStateRepoConfig(config)
    return {
      repo: state.repo,
      path: state.path,
      branch: state.branch,
      goalStatePath: `${state.path}/${goalStateLogPath(goalId)}`,
      logPath: `${state.path}/${logPath}`,
    }
  } catch {
    return undefined
  }
}

function triggerContext(): Record<string, unknown> | undefined {
  const event = readGithubEvent()
  const inputs = recordValue(event?.inputs)
  const eventName = process.env.GITHUB_EVENT_NAME?.trim() || undefined
  const githubActor = process.env.GITHUB_ACTOR?.trim() || undefined
  if (!eventName && !githubActor && !process.env.GITHUB_EVENT_PATH) return undefined
  const trigger = pruneUndefined({
    source: eventName ? "github-actions" : "local",
    kind: triggerKind(eventName),
    eventName,
    actor: githubActor,
    githubActor,
    actorRole: triggerActorRole(eventName),
    eventPath: process.env.GITHUB_EVENT_PATH?.trim() || undefined,
    issue: numberValue(recordValue(event?.issue)?.number),
    pullRequest: numberValue(recordValue(event?.pull_request)?.number),
    comment: numberValue(recordValue(event?.comment)?.id),
    schedule: stringValue(event?.schedule),
    inputs: inputs
      ? pickRecord(inputs, [
          "issue_number",
          "sessionId",
          "message",
          "model",
          "title",
          "capability",
          "implementation",
          "base",
        ])
      : undefined,
  })
  return Object.keys(trigger).length > 0 ? trigger : undefined
}

function triggerKind(eventName: string | undefined): string {
  if (!eventName) return "local"
  if (eventName === "schedule") return "schedule"
  if (eventName === "workflow_dispatch") return "manual-workflow-dispatch"
  return eventName
}

function triggerActorRole(eventName: string | undefined): string | undefined {
  if (!eventName) return undefined
  if (eventName === "schedule") return "github workflow run actor; not the manual dispatcher"
  if (eventName === "workflow_dispatch") return "manual workflow dispatcher"
  return "github event actor"
}

function jobContext(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const job = pruneUndefined({
    id: stringValue(data.jobId) ?? undefined,
    key: stringValue(data.jobKey) ?? undefined,
    flavor: stringValue(data.jobFlavor) ?? undefined,
    action: stringValue(data.jobAction) ?? undefined,
    capability: stringValue(data.jobCapability) ?? undefined,
    implementation: stringValue(data.jobImplementation) ?? undefined,
    agent: stringValue(data.jobAgent) ?? undefined,
    schedule: stringValue(data.jobSchedule) ?? undefined,
    target: data.jobTarget ?? undefined,
    model: stringValue(data.jobModel) ?? undefined,
    modelProvider: stringValue(data.jobModelProvider) ?? undefined,
    modelName: stringValue(data.jobModelName) ?? undefined,
    reasoningEffort: stringValue(data.jobReasoningEffort) ?? undefined,
    why: truncateString(stringValue(data.jobWhy), 1000),
    saveReport: data.jobSaveReport === true ? true : undefined,
  })
  return Object.keys(job).length > 0 ? job : undefined
}

function dispatchContext(
  event: GoalRunLogEvent,
  trigger: Record<string, unknown> | undefined,
  job: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!event.dispatch && event.status !== "dispatch") return undefined
  const dispatch = event.dispatch ?? {}
  const context = pruneUndefined({
    triggeredBy: triggerLabel(trigger),
    triggerKind: stringValue(trigger?.kind),
    dispatchMode: dispatchMode(trigger),
    githubActor: stringValue(trigger?.githubActor) ?? stringValue(trigger?.actor),
    githubActorRole: stringValue(trigger?.actorRole),
    decidedBy: event.source,
    dispatchedBy: event.source,
    target: event.target,
    action: dispatch.action ?? stringValue(job?.action),
    capability: dispatch.capability ?? stringValue(job?.capability),
    implementation: dispatch.implementation ?? stringValue(job?.implementation),
    reason: event.reason,
  })
  return Object.keys(context).length > 0 ? context : undefined
}

function triggerLabel(trigger: Record<string, unknown> | undefined): string {
  const kind = stringValue(trigger?.kind)
  if (kind === "schedule") return "GitHub schedule"
  if (kind === "manual-workflow-dispatch") return "manual workflow dispatch"
  if (kind === "issue_comment") return "GitHub issue comment"
  if (kind === "pull_request") return "GitHub pull request"
  if (kind) return `GitHub ${kind}`
  return "local run"
}

function dispatchMode(trigger: Record<string, unknown> | undefined): string {
  const kind = stringValue(trigger?.kind)
  if (kind === "schedule") return "automated"
  if (kind === "manual-workflow-dispatch") return "manual"
  if (kind) return "event-driven"
  return "local"
}

function linkContext(stateRepo: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const links: Record<string, unknown> = {}
  const runId = process.env.GITHUB_RUN_ID?.trim()
  const repository = process.env.GITHUB_REPOSITORY?.trim()
  const server = process.env.GITHUB_SERVER_URL?.trim() || "https://github.com"
  if (runId && repository) links.workflowRun = `${server}/${repository}/actions/runs/${runId}`

  const repo = stringValue(stateRepo?.repo)
  const branch = stringValue(stateRepo?.branch)
  const goalStatePath = stringValue(stateRepo?.goalStatePath)
  const logPath = stringValue(stateRepo?.logPath)
  if (repo && branch && goalStatePath) links.goalState = githubBlobUrl(repo, branch, goalStatePath)
  if (repo && branch && logPath) links.log = githubBlobUrl(repo, branch, logPath)
  return Object.keys(links).length > 0 ? links : undefined
}

function githubBlobUrl(repo: string, branch: string, filePath: string): string | undefined {
  try {
    const parsed = parseStateRepoSlug(repo)
    return `https://github.com/${parsed.owner}/${parsed.repo}/blob/${encodeURIComponent(branch)}/${filePath}`
  } catch {
    return undefined
  }
}

function routeStepForLog(step: GoalRouteStep): Record<string, unknown> {
  return pruneUndefined({
    evidence: step.evidence,
    stage: step.stage,
    capability: step.capability,
    implementation: step.implementation,
    args: step.args,
    saveReport: step.saveReport === true ? true : undefined,
  })
}

function readGithubEvent(): Record<string, unknown> | null {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) return null
  try {
    if (!fs.existsSync(eventPath)) return null
    const parsed = JSON.parse(fs.readFileSync(eventPath, "utf-8")) as unknown
    return recordValue(parsed)
  } catch {
    return null
  }
}

function addScalarChange(change: Record<string, unknown>, field: string, before: unknown, after: unknown): void {
  if (before === after) return
  change[field] = pruneUndefined({ from: before, to: after })
}

function diffRecordKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { added: string[]; removed: string[]; changed: string[] } {
  const beforeKeys = new Set(Object.keys(before))
  const afterKeys = new Set(Object.keys(after))
  const added = [...afterKeys].filter((key) => !beforeKeys.has(key)).sort()
  const removed = [...beforeKeys].filter((key) => !afterKeys.has(key)).sort()
  const changed = [...afterKeys]
    .filter((key) => beforeKeys.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort()
  return { added, removed, changed }
}

function diffStringArrays(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: after.filter((item) => !beforeSet.has(item)).sort(),
    removed: before.filter((item) => !afterSet.has(item)).sort(),
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function stringArrayValue(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : null
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function pickRecord(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== "") out[key] = input[key]
  }
  return out
}

function pruneUndefined<T extends Record<string, unknown>>(input: T): T {
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) delete input[key]
  }
  return input
}

function truncateString(value: string | null, max: number): string | undefined {
  if (!value) return undefined
  return value.length > max ? `${value.slice(0, max)}...` : value
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
