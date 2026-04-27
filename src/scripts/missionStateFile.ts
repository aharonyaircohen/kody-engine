/**
 * Durable mission state in a tracked repo file.
 *
 * One file per mission at `.kody/missions/<slug>.state.json`. Reads and
 * writes go through the GitHub contents API so the default GITHUB_TOKEN
 * (with `contents: write` permission) is sufficient — no user PAT or
 * `gist` scope required.
 *
 * The file holds a StateEnvelope (version, rev, cursor, data, done). Writes
 * are skipped when the next state is byte-identical to the prior state, so
 * idle ticks don't churn the git log.
 */

import { gh } from "../issue.js"
import { initialStateEnvelope, isStateEnvelope, type StateEnvelope } from "./issueStateComment.js"

export interface LoadedMissionState {
  /** Path of the state file inside the repo (relative). */
  path: string
  /** Blob SHA of the file as last read. Required for safe updates. */
  sha: string | null
  /** The decoded envelope, or a fresh seed if the file did not exist yet. */
  state: StateEnvelope
  /** True when no file existed yet — caller should always create on first write. */
  created: boolean
}

/**
 * Compute the canonical state-file path for a given mission slug. Lives next
 * to the mission body so they're easy to read together.
 */
export function stateFilePath(missionsDir: string, slug: string): string {
  return `${missionsDir.replace(/\/+$/, "")}/${slug}.state.json`
}

interface ContentsResponse {
  type: string
  encoding: string
  content: string
  sha: string
  path: string
}

/**
 * Load the state file via the contents API. Returns a seed envelope when the
 * file doesn't exist (first tick) so callers don't need to special-case it.
 */
export function loadMissionState(owner: string, repo: string, filePath: string, cwd?: string): LoadedMissionState {
  let raw = ""
  try {
    raw = gh(["api", `/repos/${owner}/${repo}/contents/${filePath}`], { cwd })
  } catch (err) {
    // 404 = file doesn't exist yet (first run). Anything else is a real error.
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/i.test(msg) || /Not Found/i.test(msg)) {
      return { path: filePath, sha: null, state: initialStateEnvelope("seed"), created: true }
    }
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`loadMissionState: contents API for ${filePath} did not return JSON`)
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`loadMissionState: contents API for ${filePath} returned non-object`)
  }
  const o = parsed as ContentsResponse
  if (o.type !== "file" || o.encoding !== "base64" || typeof o.content !== "string") {
    throw new Error(`loadMissionState: ${filePath} is not a base64 file`)
  }
  const decoded = Buffer.from(o.content, "base64").toString("utf-8")
  let envelope: unknown
  try {
    envelope = JSON.parse(decoded)
  } catch {
    throw new Error(`loadMissionState: ${filePath} is not valid JSON`)
  }
  if (!isStateEnvelope(envelope)) {
    throw new Error(`loadMissionState: ${filePath} is not a StateEnvelope`)
  }
  return { path: filePath, sha: o.sha, state: envelope, created: false }
}

/**
 * Write `next` into the state file via the contents API. No-op when the new
 * state matches the prior state (avoids commit churn on idle ticks).
 *
 * Returns true if a commit was made, false if the write was skipped.
 */
export function writeMissionState(
  owner: string,
  repo: string,
  loaded: LoadedMissionState,
  next: StateEnvelope,
  cwd?: string,
): boolean {
  // Idempotency: skip the commit when the agent's state is byte-identical to
  // what's already on disk. The rev still bumps, but a no-action tick means
  // the cursor and data are unchanged, so we don't write.
  if (!loaded.created && deepEqualsState(loaded.state, next)) {
    return false
  }

  const body = JSON.stringify(next, null, 2) + "\n"
  const payload: Record<string, unknown> = {
    message: `chore(missions): update state for ${stateFileSlug(loaded.path)} (rev ${next.rev})`,
    content: Buffer.from(body, "utf-8").toString("base64"),
  }
  if (loaded.sha) payload.sha = loaded.sha

  gh(["api", "--method", "PUT", `/repos/${owner}/${repo}/contents/${loaded.path}`, "--input", "-"], {
    cwd,
    input: JSON.stringify(payload),
  })
  return true
}

/**
 * Compare two state envelopes structurally for the purpose of avoiding no-op
 * commits. The `rev` field is excluded from the comparison — it's a write
 * counter and would falsely flag every tick as changed.
 */
function deepEqualsState(a: StateEnvelope, b: StateEnvelope): boolean {
  if (a.cursor !== b.cursor || a.done !== b.done) return false
  return JSON.stringify(a.data) === JSON.stringify(b.data)
}

function stateFileSlug(filePath: string): string {
  const last = filePath.split("/").pop() ?? filePath
  return last.replace(/\.state\.json$/i, "")
}
