/**
 * Goal state file: shape, parsing, and serialization.
 *
 * Managed goals keep lifecycle at top level and goal-manager data
 * (destination, evidence, capabilities, route, facts, blockers) in
 * the extra bag. Unknown fields are preserved on round-trip so dashboards and
 * older files do not get stomped by ticks.
 */

/** All lifecycle states a managed goal may occupy. */
export type GoalLifecycleState = "active" | "abandoned" | "closed" | "done"

const VALID_STATES: ReadonlySet<string> = new Set(["active", "abandoned", "closed", "done"])

/**
 * Strict fields goal-manager reads/writes. Other fields round-trip through
 * `extra`.
 */
export interface GoalState {
  /** Lifecycle state. Required by goal-scheduler and goal-manager. */
  state: GoalLifecycleState
  /** ISO timestamp updated when goal-manager persists a change. */
  updatedAt?: string
  /** ISO timestamp set when goal is first created. */
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
 * Serialize GoalState back to JSON shape. Known lifecycle fields come last and
 * cannot be overwritten by unknown extra data.
 */
export function serializeGoalState(s: GoalState): string {
  const obj: Record<string, unknown> = { ...s.extra, state: s.state }
  if (s.createdAt !== undefined) obj.createdAt = s.createdAt
  if (s.startedAt !== undefined) obj.startedAt = s.startedAt
  if (s.updatedAt !== undefined) obj.updatedAt = s.updatedAt
  return `${JSON.stringify(obj, null, 2)}\n`
}

/** Returns current ISO-8601 UTC timestamp matching engine's format. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
}
