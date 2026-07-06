/**
 * Task state — the store for the reducer pattern.
 *
 * Each task (issue or PR) stores canonical JSON in the configured Kody state
 * repo at tasks/issues/<number>/state.json or tasks/prs/<number>/state.json.
 * Implementations read the state at the start of a run, emit a typed Action, and
 * the reducer merges the action into a new state written back to that file.
 *
 * See docs/architecture/state-reducer-pattern.md for the full concept.
 */

import { loadConfig } from "./config.js"
import type { JobFlavor } from "./executables/types.js"
import { readStateText, type StateRepoConfig, upsertStateText } from "./stateRepo.js"

export const STATE_BEGIN = "<!-- kody:state:v1:begin -->"
export const STATE_END = "<!-- kody:state:v1:end -->"
const HISTORY_MAX_ENTRIES = 20
const JOB_RUNS_MAX_ENTRIES = 20

export type Phase = "research" | "planning" | "implementing" | "reviewing" | "shipped" | "failed" | "idle"

export type Status = "pending" | "running" | "succeeded" | "failed"

export interface TaskJobRun {
  /** One execution attempt for this job. Usually the GitHub Actions run id. */
  id: string
  timestamp: string
  action: string
  status: Status
  note?: string
  runUrl?: string
  prUrl?: string
}

export interface TaskJob {
  /** Stable id for the required work, not the per-attempt run id. */
  id: string
  implementation: string
  capability?: string
  agent?: string
  flavor?: JobFlavor
  schedule?: string
  target?: number
  reason?: string
  status: Status
  createdAt: string
  updatedAt: string
  completedAt?: string
  runUrl?: string
  prUrl?: string
  agentRuns: TaskJobRun[]
}

export interface PlannedTaskJob {
  id: string
  implementation: string
  capability?: string
  agent?: string
  flavor?: JobFlavor
  schedule?: string
  target?: number
  reason?: string
}

export interface Action {
  type: string
  payload: Record<string, unknown>
  timestamp: string
}

export interface TaskState {
  schemaVersion: 1
  core: {
    phase: Phase
    status: Status
    currentImplementation: string | null
    lastOutcome: Action | null
    attempts: Record<string, number>
    prUrl?: string
    runUrl?: string
    /**
     * Agent member the most recent run executed as (the capability's `agent`),
     * recorded by the executor when it loads + injects that agent. Durable
     * proof of *who* ran — surfaced in the rendered comment. Null/absent when
     * the run had no agent (legacy implementation with no agent).
     */
    ranAsAgent?: string | null
  }
  implementations: Record<string, ImplementationState>
  /**
   * Addressable, typed outputs produced by implementations. Persisted as a
   * top-level map so consumers never need to dig into implementations/history.
   * Producer declares output via profile.output.artifacts; consumer declares
   * input via profile.input.artifacts.
   */
  artifacts: Record<string, Artifact>
  /**
   * Durable required work for this task. This is the source of truth for
   * "what still has to complete"; history below remains a capped audit log.
   */
  jobs: Record<string, TaskJob>
  history: HistoryEntry[]
  /**
   * Optional multi-implementation flow context. Set by `startFlow`, cleared by
   * `finishFlow`. Each child's `advanceFlow` postflight reads this to know
   * whether to re-trigger the orchestrator. Absence means "no flow in
   * progress" — children run standalone and advanceFlow is a no-op.
   */
  flow?: FlowState
}

export interface FlowState {
  /** Flow definition name, e.g. "plan-build-review". */
  name: string
  /** Most recent child the orchestrator dispatched. */
  step: string
  /** Issue number where the flow was started — orchestrator's home. */
  issueNumber: number
  /** ISO timestamp of startFlow. */
  startedAt: string
  /**
   * Count of self-triggers (advanceFlow re-dispatches) so far. Loop guard:
   * advanceFlow refuses to continue past a hard cap so a flow that never
   * reaches a terminal phase can't re-trigger itself forever.
   */
  hops?: number
}

export interface Artifact {
  /** "markdown" | "text" | … — informational. */
  format: string
  /** Name of the implementation that produced this artifact. */
  producedBy: string
  /** ISO timestamp of production. */
  createdAt: string
  /** The artifact payload. Always a string today; can grow later. */
  content: string
}

export interface ImplementationState {
  lastAction: Action | null
  [key: string]: unknown
}

/**
 * One recent run attempt in the task's audit log. Durable required work lives
 * in `jobs`; `history` stays capped and human-readable.
 */
export interface HistoryEntry {
  timestamp: string
  implementation: string
  action: string
  note?: string
  /** Agent member this run executed as, when the capability declares one. */
  agent?: string
  /** Stable id for this job run (CI run id when in Actions, else a stamp). */
  jobId?: string
  /** Whether this run was an instant (`@kody`) or scheduled (cron) job. */
  flavor?: JobFlavor
  /** Cadence this scheduled job fired on (the capability's `every`/cron). */
  schedule?: string
  /** This job's outcome (mirrors core.status at the time it ran). */
  status?: Status
  /** CI run URL that executed this job, when known. */
  runUrl?: string
}

export type TaskTarget = "issue" | "pr"

export function emptyState(): TaskState {
  return {
    schemaVersion: 1,
    core: {
      phase: "idle",
      status: "pending",
      currentImplementation: null,
      lastOutcome: null,
      attempts: {},
    },
    implementations: {},
    artifacts: {},
    jobs: {},
    history: [],
  }
}

/**
 * Thrown when persisted task state is present but its payload can't be parsed.
 * Callers MUST treat this differently from emptyState(): silently substituting
 * empty state here makes the engine think an in-progress task is brand new and
 * re-do already-committed work (re-open PRs, re-run completed children). See
 * loadTaskState for the heal-then-bail recovery.
 */
export class CorruptStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CorruptStateError"
  }
}

function taskStatePath(target: TaskTarget, number: number): string {
  const bucket = target === "issue" ? "issues" : "prs"
  return `tasks/${bucket}/${number}/state.json`
}

function taskStateConfig(cwd?: string, config?: StateRepoConfig): StateRepoConfig {
  return config ?? loadConfig(cwd)
}

function normalizeTaskState(parsed: TaskState): TaskState {
  if (parsed?.schemaVersion !== 1) {
    throw new CorruptStateError(`unexpected schemaVersion: ${JSON.stringify(parsed?.schemaVersion)}`)
  }
  const currentImplementation =
    typeof parsed.core?.currentImplementation === "string" ? parsed.core.currentImplementation : null
  const implementations =
    parsed.implementations && typeof parsed.implementations === "object"
      ? parsed.implementations
      : {}
  const parsedCore = parsed.core ?? emptyState().core
  const core = {
    phase: parsedCore.phase,
    status: parsedCore.status,
    lastOutcome: parsedCore.lastOutcome,
    attempts: parsedCore.attempts,
    ...(parsedCore.prUrl ? { prUrl: parsedCore.prUrl } : {}),
    ...(parsedCore.runUrl ? { runUrl: parsedCore.runUrl } : {}),
    ...(parsedCore.ranAsAgent !== undefined ? { ranAsAgent: parsedCore.ranAsAgent } : {}),
  }
  return {
    schemaVersion: 1,
    core: { ...emptyState().core, ...core, currentImplementation },
    implementations,
    artifacts: parsed.artifacts && typeof parsed.artifacts === "object" ? parsed.artifacts : {},
    jobs: normalizeJobs((parsed as { jobs?: unknown }).jobs),
    history: normalizeHistory(parsed.history),
    flow: parsed.flow,
  }
}

export function parseStateComment(body: string): TaskState {
  const beginIdx = body.indexOf(STATE_BEGIN)
  // No marker at all → legitimately empty (no kody state written yet).
  if (beginIdx < 0) return emptyState()

  // From here the marker is present, so any parse failure is CORRUPTION — a
  // truncated or clobbered comment — not an empty task. Throw rather than
  // returning emptyState so the caller can fail loud instead of silently
  // redoing committed work.
  //
  // Use lastIndexOf for END: artifact content embedded in the JSON (e.g. a
  // plan markdown that discusses kody state) can contain literal STATE_END
  // markers. The real END marker is rendered after the closing ``` fence,
  // so it's always the last occurrence.
  const endIdx = body.lastIndexOf(STATE_END)
  if (endIdx < 0 || endIdx <= beginIdx) {
    throw new CorruptStateError("STATE_BEGIN present but STATE_END missing or misordered (truncated comment?)")
  }

  // The span between STATE_BEGIN and STATE_END is always the ```json fence
  // (see renderStateComment). Slice by position rather than regex-matching,
  // because the JSON payload can contain ``` (e.g. plan artifacts embedding
  // code blocks) which defeats a non-greedy regex and truncates the JSON.
  const between = body.slice(beginIdx + STATE_BEGIN.length, endIdx).trim()
  const OPEN = "```json"
  const CLOSE = "```"
  if (!between.startsWith(OPEN) || !between.endsWith(CLOSE)) {
    throw new CorruptStateError("state fence malformed (expected ```json…``` between markers)")
  }
  const jsonStr = between.slice(OPEN.length, between.length - CLOSE.length).trim()

  let parsed: TaskState
  try {
    parsed = JSON.parse(jsonStr) as TaskState
  } catch (err) {
    throw new CorruptStateError(
      `state JSON unparseable (truncated comment?): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return normalizeTaskState(parsed)
}

/**
 * Merge an action into state. This is the reducer. Pure function.
 *
 * `phase` is the label the caller's profile declares for successful runs.
 * Failing actions always collapse to "failed" regardless; omitted phase → "idle".
 * Keeping phase a caller-supplied parameter (rather than deriving from the
 * implementation name) lets this module stay generic — no implementation names here.
 */
/** Identity + provenance of the task job and the run being recorded. */
export interface JobMeta {
  /** Stable job key for required work on the task. */
  jobKey?: string
  /** Per-run id for this execution attempt. */
  jobId?: string
  flavor?: JobFlavor
  schedule?: string
  runUrl?: string
  prUrl?: string
  capability?: string
  implementation?: string
  target?: number
  agent?: string
  why?: string
}

export function reduce(
  state: TaskState,
  implementation: string,
  action: Action | null,
  phase?: Phase,
  agent?: string | null,
  job?: JobMeta,
): TaskState {
  if (!action) return state
  const newAttempts = { ...state.core.attempts, [implementation]: (state.core.attempts[implementation] ?? 0) + 1 }
  const newImplementations: Record<string, ImplementationState> = {
    ...state.implementations,
    [implementation]: { ...(state.implementations[implementation] ?? { lastAction: null }), lastAction: action },
  }
  const ranAsAgent = typeof agent === "string" && agent.length > 0 ? agent : undefined
  // Each run appends one audit entry. The durable job state is updated below
  // via `reduceJobs`, keyed by the stable jobKey when the caller knows it.
  const entry: HistoryEntry = {
    timestamp: action.timestamp,
    implementation,
    action: action.type,
    note: noteFromAction(action),
    agent: ranAsAgent,
    status: statusFromAction(action),
    ...(job?.jobId ? { jobId: job.jobId } : {}),
    ...(job?.flavor ? { flavor: job.flavor } : {}),
    ...(job?.schedule ? { schedule: job.schedule } : {}),
    ...(job?.runUrl ? { runUrl: job.runUrl } : {}),
  }
  const newHistory = [...state.history, entry].slice(-HISTORY_MAX_ENTRIES)
  const newJobs = reduceJobs(state.jobs ?? {}, implementation, action, agent, job)
  return {
    schemaVersion: 1,
    core: {
      ...state.core,
      attempts: newAttempts,
      lastOutcome: action,
      currentImplementation: implementation,
      ranAsAgent: ranAsAgent ?? null,
      status: statusFromAction(action),
      phase: phaseFromAction(action, phase),
    },
    implementations: newImplementations,
    artifacts: { ...(state.artifacts ?? {}) },
    jobs: newJobs,
    history: newHistory,
    flow: state.flow,
  }
}

export function upsertTaskJobs(state: TaskState, planned: PlannedTaskJob[], timestamp: string): TaskState {
  if (planned.length === 0) return state
  const jobs: Record<string, TaskJob> = { ...(state.jobs ?? {}) }
  for (const plan of planned) {
    const prior = jobs[plan.id]
    jobs[plan.id] = {
      id: plan.id,
      implementation: plan.implementation,
      ...((plan.capability ?? prior?.capability) ? { capability: plan.capability ?? prior?.capability } : {}),
      ...((plan.agent ?? prior?.agent) ? { agent: plan.agent ?? prior?.agent } : {}),
      ...((plan.flavor ?? prior?.flavor) ? { flavor: plan.flavor ?? prior?.flavor } : {}),
      ...((plan.schedule ?? prior?.schedule) ? { schedule: plan.schedule ?? prior?.schedule } : {}),
      ...(typeof plan.target === "number"
        ? { target: plan.target }
        : prior?.target !== undefined
          ? { target: prior.target }
          : {}),
      ...((plan.reason ?? prior?.reason) ? { reason: plan.reason ?? prior?.reason } : {}),
      status: prior?.status ?? "pending",
      createdAt: prior?.createdAt ?? timestamp,
      updatedAt: prior?.updatedAt ?? timestamp,
      ...(prior?.completedAt ? { completedAt: prior.completedAt } : {}),
      ...(prior?.runUrl ? { runUrl: prior.runUrl } : {}),
      ...(prior?.prUrl ? { prUrl: prior.prUrl } : {}),
      agentRuns: prior?.agentRuns ?? [],
    }
  }
  return { ...state, jobs }
}

export function nextPendingTaskJob(state: TaskState, ids?: string[]): TaskJob | null {
  const jobs = state.jobs ?? {}
  const keys = ids && ids.length > 0 ? ids : Object.keys(jobs)
  for (const key of keys) {
    const job = jobs[key]
    if (job && job.status !== "succeeded") return job
  }
  return null
}

function reduceJobs(
  jobs: Record<string, TaskJob>,
  implementation: string,
  action: Action,
  agent?: string | null,
  job?: JobMeta,
): Record<string, TaskJob> {
  const status = statusFromAction(action)
  const id = job?.jobKey || job?.jobId || `legacy:${implementation}`
  const prior = jobs[id]
  const note = noteFromAction(action)
  const prUrl = job?.prUrl ?? prUrlFromAction(action)
  const run: TaskJobRun = {
    id: job?.jobId || `${id}:${action.timestamp}`,
    timestamp: action.timestamp,
    action: action.type,
    status,
    ...(note ? { note } : {}),
    ...(job?.runUrl ? { runUrl: job.runUrl } : {}),
    ...(prUrl ? { prUrl } : {}),
  }
  const runs = [...(prior?.agentRuns ?? []), run].slice(-JOB_RUNS_MAX_ENTRIES)
  const ranAsAgent = typeof agent === "string" && agent.length > 0 ? agent : job?.agent
  const next: TaskJob = {
    id,
    implementation: job?.implementation ?? prior?.implementation ?? implementation,
    ...((job?.capability ?? prior?.capability) ? { capability: job?.capability ?? prior?.capability } : {}),
    ...((ranAsAgent ?? prior?.agent) ? { agent: ranAsAgent ?? prior?.agent } : {}),
    ...((job?.flavor ?? prior?.flavor) ? { flavor: job?.flavor ?? prior?.flavor } : {}),
    ...((job?.schedule ?? prior?.schedule) ? { schedule: job?.schedule ?? prior?.schedule } : {}),
    ...(typeof job?.target === "number"
      ? { target: job.target }
      : prior?.target !== undefined
        ? { target: prior.target }
        : {}),
    ...((job?.why ?? prior?.reason) ? { reason: job?.why ?? prior?.reason } : {}),
    status,
    createdAt: prior?.createdAt ?? action.timestamp,
    updatedAt: action.timestamp,
    ...(status === "succeeded" ? { completedAt: action.timestamp } : {}),
    ...((job?.runUrl ?? prior?.runUrl) ? { runUrl: job?.runUrl ?? prior?.runUrl } : {}),
    ...((prUrl ?? prior?.prUrl) ? { prUrl: prUrl ?? prior?.prUrl } : {}),
    agentRuns: runs,
  }
  return { ...jobs, [id]: next }
}

function statusFromAction(action: Action): Status {
  if (/FAILED$|ERROR$|MISSING$|REJECTED$/i.test(action.type)) return "failed"
  if (/COMPLETED$|SHIPPED$|MERGED$|SUCCESS$/i.test(action.type)) return "succeeded"
  return "running"
}

function phaseFromAction(action: Action, phase?: Phase): Phase {
  if (/FAILED$|ERROR$|REJECTED$/i.test(action.type)) return "failed"
  return phase ?? "idle"
}

function noteFromAction(action: Action): string | undefined {
  const p = action.payload
  if (typeof p?.prUrl === "string") return p.prUrl as string
  if (typeof p?.reason === "string") return (p.reason as string).slice(0, 120)
  if (typeof p?.commitMessage === "string") return (p.commitMessage as string).slice(0, 120)
  return undefined
}

function prUrlFromAction(action: Action): string | undefined {
  const p = action.payload
  return typeof p?.prUrl === "string" ? (p.prUrl as string) : undefined
}

function normalizeJobs(input: unknown): Record<string, TaskJob> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const out: Record<string, TaskJob> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const raw = value as Partial<TaskJob>
    const implementation = typeof raw.implementation === "string" ? raw.implementation : undefined
    if (typeof raw.id !== "string" || typeof implementation !== "string") continue
    if (!isStatus(raw.status)) continue
    out[key] = {
      id: raw.id,
      implementation,
      ...(typeof raw.capability === "string" ? { capability: raw.capability } : {}),
      ...(typeof raw.agent === "string" ? { agent: raw.agent } : {}),
      ...(raw.flavor === "instant" || raw.flavor === "scheduled" ? { flavor: raw.flavor } : {}),
      ...(typeof raw.schedule === "string" ? { schedule: raw.schedule } : {}),
      ...(typeof raw.target === "number" ? { target: raw.target } : {}),
      ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
      status: raw.status,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      ...(typeof raw.completedAt === "string" ? { completedAt: raw.completedAt } : {}),
      ...(typeof raw.runUrl === "string" ? { runUrl: raw.runUrl } : {}),
      ...(typeof raw.prUrl === "string" ? { prUrl: raw.prUrl } : {}),
      agentRuns: Array.isArray(raw.agentRuns) ? raw.agentRuns.filter(isTaskJobRun).slice(-JOB_RUNS_MAX_ENTRIES) : [],
    }
  }
  return out
}

function normalizeHistory(input: unknown): HistoryEntry[] {
  if (!Array.isArray(input)) return []
  const out: HistoryEntry[] = []
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const raw = value as Partial<HistoryEntry>
    const implementation = typeof raw.implementation === "string" ? raw.implementation : undefined
    if (typeof raw.timestamp !== "string" || typeof implementation !== "string" || typeof raw.action !== "string") {
      continue
    }
    out.push({
      timestamp: raw.timestamp,
      implementation,
      action: raw.action,
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
      ...(typeof raw.agent === "string" ? { agent: raw.agent } : {}),
      ...(typeof raw.jobId === "string" ? { jobId: raw.jobId } : {}),
      ...(raw.flavor === "instant" || raw.flavor === "scheduled" ? { flavor: raw.flavor } : {}),
      ...(typeof raw.schedule === "string" ? { schedule: raw.schedule } : {}),
      ...(isStatus(raw.status) ? { status: raw.status } : {}),
      ...(typeof raw.runUrl === "string" ? { runUrl: raw.runUrl } : {}),
    })
  }
  return out
}

function isTaskJobRun(input: unknown): input is TaskJobRun {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const run = input as Partial<TaskJobRun>
  return (
    typeof run.id === "string" &&
    typeof run.timestamp === "string" &&
    typeof run.action === "string" &&
    isStatus(run.status)
  )
}

function isStatus(input: unknown): input is Status {
  return input === "pending" || input === "running" || input === "succeeded" || input === "failed"
}

/**
 * Serialize state into the full comment body. Order is human-first:
 *   1. Title + summary bullets
 *   2. Recent history
 *   3. Collapsed `<details>` block with the canonical machine state
 *      (still bracketed by STATE_BEGIN/STATE_END so parseStateComment
 *      finds it via positional slicing).
 *
 * Putting the machine state at the bottom inside <details> keeps the
 * comment glanceable on GitHub while preserving the wire format.
 */
export function renderStateComment(state: TaskState): string {
  const lines: string[] = []

  // ── Human-readable header + summary ────────────────────────────────────
  lines.push("## 📋 kody task state")
  lines.push("")
  if (state.flow) {
    lines.push(`- **Flow:** \`${state.flow.name}\` (step: \`${state.flow.step}\`)`)
  }
  lines.push(`- **Phase:** \`${state.core.phase}\`  **Status:** \`${state.core.status}\``)
  if (state.core.currentImplementation) {
    lines.push(`- **Last implementation:** \`${state.core.currentImplementation}\``)
  }
  if (state.core.ranAsAgent) {
    lines.push(`- **Ran as:** \`${state.core.ranAsAgent}\``)
  }
  if (state.core.lastOutcome) {
    lines.push(`- **Last action:** \`${state.core.lastOutcome.type}\``)
  }
  const attempts = Object.entries(state.core.attempts)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ")
  if (attempts) lines.push(`- **Attempts:** ${attempts}`)
  if (state.core.prUrl) lines.push(`- **PR:** ${state.core.prUrl}`)
  if (state.core.runUrl) lines.push(`- **Run:** ${state.core.runUrl}`)
  const jobEntries = Object.values(state.jobs ?? {})
  if (jobEntries.length > 0) {
    const completed = jobEntries.filter((j) => j.status === "succeeded").length
    lines.push(`- **Jobs:** ${completed}/${jobEntries.length} complete`)
  }
  const artifactNames = Object.keys(state.artifacts ?? {})
  if (artifactNames.length > 0) {
    lines.push(`- **Artifacts:** ${artifactNames.map((n) => `\`${n}\``).join(", ")}`)
  }
  lines.push("")

  // ── Recent history ─────────────────────────────────────────────────────
  if (state.history.length > 0) {
    lines.push("### Recent history")
    lines.push("")
    const recent = state.history.slice(-10).reverse()
    for (const h of recent) {
      const note = h.note ? ` — ${h.note}` : ""
      lines.push(`- \`${h.timestamp}\` **${h.implementation}** → \`${h.action}\`${note}`)
    }
    lines.push("")
  }

  // ── Jobs ───────────────────────────────────────────────────────────────
  if (jobEntries.length > 0) {
    lines.push("### Jobs")
    lines.push("")
    for (const job of jobEntries) {
      lines.push(`- \`${job.id}\` **${job.implementation}** → \`${job.status}\` (${job.agentRuns.length} runs)`)
    }
    lines.push("")
  }

  // ── Machine state (collapsed) ──────────────────────────────────────────
  lines.push("<details>")
  lines.push("<summary>Raw state (JSON)</summary>")
  lines.push("")
  lines.push(STATE_BEGIN)
  lines.push("")
  lines.push("```json")
  lines.push(
    JSON.stringify(
      {
        schemaVersion: state.schemaVersion,
        core: state.core,
        artifacts: state.artifacts ?? {},
        jobs: state.jobs ?? {},
        implementations: state.implementations,
        history: state.history,
        ...(state.flow ? { flow: state.flow } : {}),
      },
      null,
      2,
    ),
  )
  lines.push("```")
  lines.push("")
  lines.push(STATE_END)
  lines.push("")
  lines.push("</details>")

  return lines.join("\n")
}

export function readTaskState(target: TaskTarget, number: number, cwd?: string, config?: StateRepoConfig): TaskState {
  const stateConfig = taskStateConfig(cwd, config)
  const loaded = readStateText(stateConfig, cwd, taskStatePath(target, number))
  if (!loaded) return emptyState()

  let parsed: TaskState
  try {
    parsed = JSON.parse(loaded.content) as TaskState
  } catch (err) {
    throw new CorruptStateError(
      `state repo JSON unparseable for ${loaded.path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return normalizeTaskState(parsed)
}

/**
 * Immutable update: return a new state with the named artifact set. Used by
 * the persistArtifacts postflight so declared outputs land in a stable slot.
 */
export function setArtifact(state: TaskState, name: string, artifact: Artifact): TaskState {
  return {
    ...state,
    artifacts: { ...(state.artifacts ?? {}), [name]: artifact },
  }
}

export function writeTaskState(
  target: TaskTarget,
  number: number,
  state: TaskState,
  cwd?: string,
  config?: StateRepoConfig,
): void {
  const stateConfig = taskStateConfig(cwd, config)
  upsertStateText(
    stateConfig,
    cwd,
    taskStatePath(target, number),
    `${JSON.stringify(state, null, 2)}\n`,
    `chore(tasks): update ${target} ${number} state`,
  )
}
