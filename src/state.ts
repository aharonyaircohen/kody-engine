/**
 * Task state — the store for the reducer pattern.
 *
 * Each task (issue or PR) owns at most one kody-authored comment whose
 * body holds the canonical state. Executables read the state at the start
 * of a run, emit a typed Action, and the reducer merges the action into a
 * new state which is written back into the same comment.
 *
 * See docs/architecture/state-reducer-pattern.md for the full concept.
 */

import { execFileSync } from "node:child_process"
import type { JobFlavor } from "./executables/types.js"

export const STATE_BEGIN = "<!-- kody:state:v1:begin -->"
export const STATE_END = "<!-- kody:state:v1:end -->"
const HISTORY_MAX_ENTRIES = 20
const API_TIMEOUT_MS = 30_000

export type Phase = "research" | "planning" | "implementing" | "reviewing" | "shipped" | "failed" | "idle"

export type Status = "pending" | "running" | "succeeded" | "failed"

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
    currentExecutable: string | null
    lastOutcome: Action | null
    attempts: Record<string, number>
    prUrl?: string
    runUrl?: string
    /**
     * Staff member the most recent run executed as (the duty's `staff`),
     * recorded by the executor when it loads + injects that persona. Durable
     * proof of *who* ran — surfaced in the rendered comment. Null/absent when
     * the run had no staff (legacy executable with no persona).
     */
    ranAsStaff?: string | null
  }
  executables: Record<string, ExecutableState>
  /**
   * Addressable, typed outputs produced by executables. Persisted as a
   * top-level map so consumers never need to dig into executables/history.
   * Producer declares output via profile.output.artifacts; consumer declares
   * input via profile.input.artifacts.
   */
  artifacts: Record<string, Artifact>
  history: HistoryEntry[]
  /**
   * Optional multi-executable flow context. Set by `startFlow`, cleared by
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
  /** Name of the executable that produced this artifact. */
  producedBy: string
  /** ISO timestamp of production. */
  createdAt: string
  /** The artifact payload. Always a string today; can grow later. */
  content: string
}

export interface ExecutableState {
  lastAction: Action | null
  [key: string]: unknown
}

/**
 * One job in the task's ledger. A task (this TaskState) IS the ordered list of
 * these `history` entries plus the rolled-up `core` state. Each engine run
 * appends exactly one entry, so — per the model's decision — a re-run is a NEW
 * job (a new entry), and `history` is the run-history of jobs on this issue/PR.
 */
export interface HistoryEntry {
  timestamp: string
  executable: string
  action: string
  note?: string
  /** Staff member this run executed as, when the duty declares one. */
  staff?: string
  /** Stable id for this job run (CI run id when in Actions, else a stamp). */
  jobId?: string
  /** Whether this run was an instant (`@kody`) or scheduled (cron) job. */
  flavor?: JobFlavor
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
      currentExecutable: null,
      lastOutcome: null,
      attempts: {},
    },
    executables: {},
    artifacts: {},
    history: [],
  }
}

function ghToken(): string | undefined {
  return process.env.GH_PAT?.trim() || process.env.GH_TOKEN
}

function gh(args: string[], input?: string, cwd?: string): string {
  const token = ghToken()
  const env: NodeJS.ProcessEnv = token ? { ...process.env, GH_TOKEN: token } : { ...process.env }
  return execFileSync("gh", args, {
    encoding: "utf-8",
    timeout: API_TIMEOUT_MS,
    cwd,
    env,
    input,
    stdio: input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  }).trim()
}

/**
 * Locate the kody-owned state comment on a task. Returns the comment id +
 * body, or null if no such comment exists.
 */
export function findStateComment(
  target: TaskTarget,
  number: number,
  cwd?: string,
): { id: string; body: string } | null {
  const apiPath =
    target === "issue"
      ? `repos/{owner}/{repo}/issues/${number}/comments`
      : `repos/{owner}/{repo}/issues/${number}/comments`
  try {
    const raw = gh(["api", "--paginate", apiPath], undefined, cwd)
    const list = JSON.parse(raw) as Array<{ id: number; body: string }>
    for (const c of list) {
      if (c.body?.includes(STATE_BEGIN)) {
        return { id: String(c.id), body: c.body }
      }
    }
  } catch {
    /* fall through */
  }
  return null
}

/**
 * Thrown when a state comment is PRESENT (STATE_BEGIN found) but its payload
 * can't be parsed — a truncated comment (GitHub's 64KB body cap), a clobbered
 * write, or a corrupted fence. Distinct from "no comment at all," which is a
 * legitimately empty state. Callers MUST treat this differently from
 * emptyState(): silently substituting empty state here makes the engine think
 * an in-progress task is brand new and re-do already-committed work (re-open
 * PRs, re-run completed children). See loadTaskState for the heal-then-bail
 * recovery.
 */
export class CorruptStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CorruptStateError"
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
  if (parsed?.schemaVersion !== 1) {
    throw new CorruptStateError(`unexpected schemaVersion: ${JSON.stringify(parsed?.schemaVersion)}`)
  }
  return {
    schemaVersion: 1,
    core: { ...emptyState().core, ...parsed.core },
    executables: parsed.executables ?? {},
    artifacts: parsed.artifacts && typeof parsed.artifacts === "object" ? parsed.artifacts : {},
    history: Array.isArray(parsed.history) ? parsed.history : [],
    flow: parsed.flow,
  }
}

/**
 * Merge an action into state. This is the reducer. Pure function.
 *
 * `phase` is the label the caller's profile declares for successful runs.
 * Failing actions always collapse to "failed" regardless; omitted phase → "idle".
 * Keeping phase a caller-supplied parameter (rather than deriving from the
 * executable name) lets this module stay generic — no executable names here.
 */
/** Identity + provenance of the job being recorded (see HistoryEntry). */
export interface JobMeta {
  jobId?: string
  flavor?: JobFlavor
  runUrl?: string
}

export function reduce(
  state: TaskState,
  executable: string,
  action: Action | null,
  phase?: Phase,
  staff?: string | null,
  job?: JobMeta,
): TaskState {
  if (!action) return state
  const newAttempts = { ...state.core.attempts, [executable]: (state.core.attempts[executable] ?? 0) + 1 }
  const newExecutables: Record<string, ExecutableState> = {
    ...state.executables,
    [executable]: { ...(state.executables[executable] ?? { lastAction: null }), lastAction: action },
  }
  const ranAsStaff = typeof staff === "string" && staff.length > 0 ? staff : undefined
  // Each run appends one job record — the task IS this ordered list. Stamp the
  // job's identity (id/flavor/runUrl) when the caller knows it, plus the
  // per-job outcome so a reader can see which jobs on this task failed.
  const entry: HistoryEntry = {
    timestamp: action.timestamp,
    executable,
    action: action.type,
    note: noteFromAction(action),
    staff: ranAsStaff,
    status: statusFromAction(action),
    ...(job?.jobId ? { jobId: job.jobId } : {}),
    ...(job?.flavor ? { flavor: job.flavor } : {}),
    ...(job?.runUrl ? { runUrl: job.runUrl } : {}),
  }
  const newHistory = [...state.history, entry].slice(-HISTORY_MAX_ENTRIES)
  return {
    schemaVersion: 1,
    core: {
      ...state.core,
      attempts: newAttempts,
      lastOutcome: action,
      currentExecutable: executable,
      ranAsStaff: ranAsStaff ?? null,
      status: statusFromAction(action),
      phase: phaseFromAction(action, phase),
    },
    executables: newExecutables,
    artifacts: { ...(state.artifacts ?? {}) },
    history: newHistory,
    flow: state.flow,
  }
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
  if (state.core.currentExecutable) {
    lines.push(`- **Last executable:** \`${state.core.currentExecutable}\``)
  }
  if (state.core.ranAsStaff) {
    lines.push(`- **Ran as:** \`${state.core.ranAsStaff}\``)
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
      lines.push(`- \`${h.timestamp}\` **${h.executable}** → \`${h.action}\`${note}`)
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
        executables: state.executables,
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

export function readTaskState(target: TaskTarget, number: number, cwd?: string): TaskState {
  const existing = findStateComment(target, number, cwd)
  return existing ? parseStateComment(existing.body) : emptyState()
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

export function writeTaskState(target: TaskTarget, number: number, state: TaskState, cwd?: string): void {
  const body = renderStateComment(state)
  const existing = findStateComment(target, number, cwd)
  try {
    if (existing) {
      gh(["api", `repos/{owner}/{repo}/issues/comments/${existing.id}`, "-X", "PATCH", "-F", "body=@-"], body, cwd)
    } else {
      const sub = target === "issue" ? "issue" : "pr"
      gh([sub, "comment", String(number), "--body-file", "-"], body, cwd)
    }
  } catch (err) {
    process.stderr.write(
      `[kody state] failed to write state on ${target} #${number}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}
