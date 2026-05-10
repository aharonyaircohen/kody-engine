/**
 * Goal state file: shape, parsing, and disk I/O.
 *
 * Mirrors the JSON written by tick.sh (and now by the TS chain) at
 * `.kody/goals/<id>/state.json`. Schema is intentionally permissive
 * (unknown fields preserved on round-trip) so existing repos upgrade
 * without losing data.
 */

import * as fs from "node:fs"
import * as path from "node:path"

/** All state values a goal may occupy. Drives the phase machine. */
export type GoalLifecycleState = "active" | "abandoned" | "closed" | "done"

const VALID_STATES: ReadonlySet<string> = new Set(["active", "abandoned", "closed", "done"])

/**
 * Strict view of fields the tick reads or writes. Other fields (e.g.
 * `title`, `description` written by the dashboard) round-trip via
 * the `extra` bag below.
 */
export interface GoalState {
  /** Lifecycle state. Required — drives phase derivation. */
  state: GoalLifecycleState
  /** Umbrella GitHub issue number. Set by ensureUmbrellaIssue. */
  goalIssueNumber?: number
  /** Most recently dispatched task issue number. Audit trail. */
  lastDispatchedIssue?: number
  /** Final goal-PR URL (`goal-<id>` → default-branch). Set by ensureGoalPr / finalize. */
  goalPrUrl?: string
  /** ISO timestamp updated on every tick. */
  updatedAt?: string
  /** ISO timestamp set when the goal first transitioned to `state==="active"`. */
  createdAt?: string
  /** Same as createdAt for older goals; legacy field name. */
  startedAt?: string
  /** ISO timestamp set when the goal transitioned to `state==="done"`. */
  completedAt?: string
  /**
   * Forward-compat: any other JSON keys present on disk pass through
   * unchanged on save. Lets the dashboard write fields the tick doesn't
   * understand without the tick stomping them.
   */
  extra: Record<string, unknown>
}

export class GoalStateError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`Invalid goal state at ${path}:\n  ${message}`)
    this.name = "GoalStateError"
  }
}

/**
 * Parse a raw JSON-decoded value into a typed GoalState. Throws on
 * shape mismatches with the file path attached for diagnosis.
 */
export function parseGoalState(filePath: string, raw: unknown): GoalState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GoalStateError(filePath, "must be a JSON object")
  }
  const r = raw as Record<string, unknown>

  const stateValue = r.state
  if (typeof stateValue !== "string" || !VALID_STATES.has(stateValue)) {
    throw new GoalStateError(
      filePath,
      `"state" is required and must be one of: ${[...VALID_STATES].join(" | ")} (got ${JSON.stringify(stateValue)})`,
    )
  }

  const parsed: GoalState = {
    state: stateValue as GoalLifecycleState,
    extra: {},
  }

  if (typeof r.goalIssueNumber === "number" && Number.isFinite(r.goalIssueNumber)) {
    parsed.goalIssueNumber = r.goalIssueNumber
  }
  if (typeof r.lastDispatchedIssue === "number" && Number.isFinite(r.lastDispatchedIssue)) {
    parsed.lastDispatchedIssue = r.lastDispatchedIssue
  }
  if (typeof r.goalPrUrl === "string" && r.goalPrUrl.length > 0) {
    parsed.goalPrUrl = r.goalPrUrl
  }
  for (const ts of ["updatedAt", "createdAt", "startedAt", "completedAt"] as const) {
    const v = r[ts]
    if (typeof v === "string" && v.length > 0) parsed[ts] = v
  }

  // Capture every other field on `extra` so it round-trips on save.
  const known = new Set([
    "state",
    "goalIssueNumber",
    "lastDispatchedIssue",
    "goalPrUrl",
    "updatedAt",
    "createdAt",
    "startedAt",
    "completedAt",
  ])
  for (const [k, v] of Object.entries(r)) {
    if (!known.has(k)) parsed.extra[k] = v
  }

  return parsed
}

/**
 * Serialize a GoalState back to the JSON shape on disk. Known fields
 * come first (stable diffs); `extra` fields trail.
 */
export function serializeGoalState(s: GoalState): string {
  const obj: Record<string, unknown> = { ...s.extra, state: s.state }
  if (s.goalIssueNumber !== undefined) obj.goalIssueNumber = s.goalIssueNumber
  if (s.lastDispatchedIssue !== undefined) obj.lastDispatchedIssue = s.lastDispatchedIssue
  if (s.goalPrUrl !== undefined) obj.goalPrUrl = s.goalPrUrl
  if (s.createdAt !== undefined) obj.createdAt = s.createdAt
  if (s.startedAt !== undefined) obj.startedAt = s.startedAt
  if (s.completedAt !== undefined) obj.completedAt = s.completedAt
  if (s.updatedAt !== undefined) obj.updatedAt = s.updatedAt
  return `${JSON.stringify(obj, null, 2)}\n`
}

/** Resolve `<cwd>/.kody/goals/<id>/state.json` for a goal id. */
export function goalStatePath(cwd: string, goalId: string): string {
  return path.join(cwd, ".kody", "goals", goalId, "state.json")
}

/** Read + parse the goal state file. Throws GoalStateError on any failure. */
export function readGoalState(cwd: string, goalId: string): GoalState {
  const file = goalStatePath(cwd, goalId)
  if (!fs.existsSync(file)) {
    throw new GoalStateError(file, "file not found")
  }
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"))
  } catch (err) {
    throw new GoalStateError(file, `invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  return parseGoalState(file, raw)
}

/** Write the state back to disk. Best-effort writeFile; no atomicity guarantees. */
export function writeGoalState(cwd: string, goalId: string, state: GoalState): void {
  const file = goalStatePath(cwd, goalId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, serializeGoalState(state), "utf-8")
}

/** Returns a current ISO-8601 UTC timestamp matching the engine's existing format. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
}
