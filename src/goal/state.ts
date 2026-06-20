/**
 * Goal state file: shape, parsing, and disk I/O.
 *
 * Managed goals keep lifecycle at the top level and goal-manager data
 * (destination, evidence, duties, route, facts, blockers) in the extra bag.
 * Unknown fields are preserved on round-trip so dashboards and older files do
 * not get stomped by ticks.
 */

import * as fs from "node:fs"
import * as path from "node:path"

/** All lifecycle states a managed goal may occupy. */
export type GoalLifecycleState = "active" | "abandoned" | "closed" | "done"

const VALID_STATES: ReadonlySet<string> = new Set(["active", "abandoned", "closed", "done"])

/**
 * Strict view fields goal-manager reads and writes. Other fields round-trip
 * through `extra`.
 */
export interface GoalState {
  /** Lifecycle state. Required by goal-scheduler and goal-manager. */
  state: GoalLifecycleState
  /** ISO timestamp updated when goal-manager persists a change. */
  updatedAt?: string
  /** ISO timestamp set when a goal is first created. */
  createdAt?: string
  /** Legacy creation timestamp name; preserved for existing files. */
  startedAt?: string
  /** Managed-goal payload plus unknown dashboard/legacy fields. */
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
 * Parse raw JSON-decoded value into typed GoalState. Throws on shape
 * mismatches with the file path attached for diagnosis.
 */
export function parseGoalState(filePath: string, raw: unknown): GoalState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GoalStateError(filePath, "must be JSON object")
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

  for (const ts of ["updatedAt", "createdAt", "startedAt"] as const) {
    const v = r[ts]
    if (typeof v === "string" && v.length > 0) parsed[ts] = v
  }

  const known = new Set(["state", "updatedAt", "createdAt", "startedAt"])
  for (const [k, v] of Object.entries(r)) {
    if (!known.has(k)) parsed.extra[k] = v
  }

  return parsed
}

/**
 * Serialize GoalState back to the JSON shape on disk. Known lifecycle fields
 * come last so they cannot be overwritten by unknown extra data.
 */
export function serializeGoalState(s: GoalState): string {
  const obj: Record<string, unknown> = { ...s.extra, state: s.state }
  if (s.createdAt !== undefined) obj.createdAt = s.createdAt
  if (s.startedAt !== undefined) obj.startedAt = s.startedAt
  if (s.updatedAt !== undefined) obj.updatedAt = s.updatedAt
  return `${JSON.stringify(obj, null, 2)}\n`
}

/** Resolve `<cwd>/.kody/goals/instances/<id>/state.json` for a goal id. */
export function goalStatePath(cwd: string, goalId: string): string {
  return path.join(cwd, ".kody", "goals", "instances", goalId, "state.json")
}

/** Read and parse a goal state file. Throws GoalStateError on any failure. */
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

/** Write state back to disk. Best-effort writeFile; no atomicity guarantees. */
export function writeGoalState(cwd: string, goalId: string, state: GoalState): void {
  const file = goalStatePath(cwd, goalId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, serializeGoalState(state), "utf-8")
}

/** Returns the current ISO-8601 UTC timestamp matching the engine's format. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
}
