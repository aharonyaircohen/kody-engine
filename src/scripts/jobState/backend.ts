/**
 * JobStateBackend — storage abstraction for file-based job state.
 *
 * The engine treats job state as a `StateEnvelope` keyed by job slug.
 * How that state is durably stored (tracked file via Contents API; test seams
 * may use local files) is a backend concern.
 *
 * Lifecycle:
 *   hydrate?()                 — once per workflow run, before any tick
 *   load(slug)                 — once per tick, before the agent runs
 *   save(loaded, next)         — once per tick, after the agent runs
 *   persist?()                 — once per workflow run, after every tick
 *                                (called in a finally block by the dispatcher)
 *
 * `hydrate` and `persist` are optional — backends that are always live
 * (e.g. contents-API) leave them undefined. Backends that snapshot the
 * job directory between runs implement them.
 */

import type { StateEnvelope } from "../issueStateComment.js"

export interface LoadedJobState {
  /** Path of the state file inside the repo (relative). Surfaced for logs/debug. */
  path: string
  /**
   * Backend-private token returned from `load`, passed back unchanged to
   * `save`. Examples: blob SHA for the contents-API backend; null for
   * local-file. Job-tick logic must treat this as opaque.
   */
  handle: unknown
  /** The decoded envelope, or a fresh seed if no prior state existed. */
  state: StateEnvelope
  /** True when no prior state existed — backends use this to skip equality checks. */
  created: boolean
}

export interface JobStateBackend {
  /** Human-readable backend name for logging. */
  readonly name: string

  /**
   * Restore prior state from the durable store into the runtime environment
   * the backend uses (in-memory map, on-disk files, …). Called once per
   * workflow run before any ticks. Optional — backends that read live can
   * omit this.
   */
  hydrate?(): Promise<void>

  /**
   * Snapshot the runtime state back to the durable store. Called once per
   * workflow run after every tick, even on failure (in a finally block).
   * Optional — backends that write live can omit this.
   */
  persist?(): Promise<void>

  /**
   * Load the state for a single job slug. Returns a fresh seed envelope
   * (with `created: true`) when no prior state exists.
   */
  load(slug: string): LoadedJobState | Promise<LoadedJobState>

  /**
   * Persist `next` for the slug carried by `loaded`. Returns true if the
   * write happened, false if it was skipped as a no-op (state unchanged).
   */
  save(loaded: LoadedJobState, next: StateEnvelope): boolean | Promise<boolean>
}

/**
 * Structural equality for StateEnvelope, ignoring `rev` (write counter that
 * would falsely flag every tick as changed). Shared by all backends so they
 * agree on what "no-op tick" means.
 */
export function isStateUnchanged(prev: StateEnvelope, next: StateEnvelope): boolean {
  if (prev.cursor !== next.cursor) return false
  if (prev.done !== next.done) return false
  return JSON.stringify(prev.data) === JSON.stringify(next.data)
}

/**
 * Compute the canonical state-file path for a given capability slug. Backends
 * that map slugs to files use this so all backends agree on the folder
 * layout: `.kody-engine/definitions/capabilities/<slug>/state.json`.
 */
export function stateFilePath(jobsDir: string, slug: string): string {
  return `${jobsDir.replace(/\/+$/, "")}/${slug}/state.json`
}

/**
 * Extract the slug from a state-file path. Inverse of `stateFilePath`.
 */
export function slugFromStateFilePath(filePath: string): string {
  if (/\/state\.json$/i.test(filePath)) {
    const parts = filePath.split("/")
    return parts.at(-2) ?? filePath
  }
  const last = filePath.split("/").pop() ?? filePath
  return last.replace(/\.state\.json$/i, "")
}
