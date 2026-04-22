/**
 * Task state — the store for the reducer pattern.
 *
 * Each task (issue or PR) owns at most one kody2-authored comment whose
 * body holds the canonical state. Executables read the state at the start
 * of a run, emit a typed Action, and the reducer merges the action into a
 * new state which is written back into the same comment.
 *
 * See docs/architecture/state-reducer-pattern.md for the full concept.
 */

import { execFileSync } from "node:child_process"

export const STATE_BEGIN = "<!-- kody2:state:v1:begin -->"
export const STATE_END = "<!-- kody2:state:v1:end -->"
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

export interface HistoryEntry {
  timestamp: string
  executable: string
  action: string
  note?: string
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
 * Locate the kody2-owned state comment on a task. Returns the comment id +
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

export function parseStateComment(body: string): TaskState {
  const beginIdx = body.indexOf(STATE_BEGIN)
  const endIdx = body.indexOf(STATE_END, beginIdx + 1)
  if (beginIdx < 0 || endIdx < 0) return emptyState()

  const between = body.slice(beginIdx + STATE_BEGIN.length, endIdx)
  const fenceMatch = between.match(/```json\s*([\s\S]*?)\s*```/)
  if (!fenceMatch) return emptyState()

  try {
    const parsed = JSON.parse(fenceMatch[1]!) as TaskState
    if (parsed?.schemaVersion !== 1) return emptyState()
    return {
      schemaVersion: 1,
      core: { ...emptyState().core, ...parsed.core },
      executables: parsed.executables ?? {},
      artifacts: parsed.artifacts && typeof parsed.artifacts === "object" ? parsed.artifacts : {},
      history: Array.isArray(parsed.history) ? parsed.history : [],
    }
  } catch {
    return emptyState()
  }
}

/**
 * Merge an action into state. This is the reducer. Pure function.
 */
export function reduce(state: TaskState, executable: string, action: Action | null): TaskState {
  if (!action) return state
  const newAttempts = { ...state.core.attempts, [executable]: (state.core.attempts[executable] ?? 0) + 1 }
  const newExecutables: Record<string, ExecutableState> = {
    ...state.executables,
    [executable]: { ...(state.executables[executable] ?? { lastAction: null }), lastAction: action },
  }
  const newHistory = [
    ...state.history,
    { timestamp: action.timestamp, executable, action: action.type, note: noteFromAction(action) },
  ].slice(-HISTORY_MAX_ENTRIES)
  return {
    schemaVersion: 1,
    core: {
      ...state.core,
      attempts: newAttempts,
      lastOutcome: action,
      currentExecutable: executable,
      status: statusFromAction(action),
      phase: phaseFromAction(executable, action),
    },
    executables: newExecutables,
    artifacts: { ...(state.artifacts ?? {}) },
    history: newHistory,
  }
}

function statusFromAction(action: Action): Status {
  if (/FAILED$|ERROR$|MISSING$|REJECTED$/i.test(action.type)) return "failed"
  if (/COMPLETED$|SHIPPED$|MERGED$|SUCCESS$/i.test(action.type)) return "succeeded"
  return "running"
}

function phaseFromAction(executable: string, action: Action): Phase {
  if (/FAILED$|ERROR$|REJECTED$/i.test(action.type)) return "failed"
  if (executable === "build") return statusFromAction(action) === "succeeded" ? "implementing" : "implementing"
  if (executable === "review") return "reviewing"
  if (executable === "release") return "shipped"
  return "idle"
}

function noteFromAction(action: Action): string | undefined {
  const p = action.payload
  if (typeof p?.prUrl === "string") return p.prUrl as string
  if (typeof p?.reason === "string") return (p.reason as string).slice(0, 120)
  if (typeof p?.commitMessage === "string") return (p.commitMessage as string).slice(0, 120)
  return undefined
}

/**
 * Serialize state into the full comment body (machine block + human summary).
 */
export function renderStateComment(state: TaskState): string {
  const lines: string[] = []
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
      },
      null,
      2,
    ),
  )
  lines.push("```")
  lines.push("")
  lines.push(STATE_END)
  lines.push("")
  lines.push("## kody2 task state")
  lines.push("")
  lines.push(`- **Phase:** \`${state.core.phase}\`  **Status:** \`${state.core.status}\``)
  if (state.core.currentExecutable) {
    lines.push(`- **Last executable:** \`${state.core.currentExecutable}\``)
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
      `[kody2 state] failed to write state on ${target} #${number}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}
