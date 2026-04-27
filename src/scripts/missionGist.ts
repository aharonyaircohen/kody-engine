/**
 * Durable mission state in a per-mission GitHub Gist.
 *
 * One gist per (owner, repo, slug) tuple, discovered by description prefix:
 *
 *     kody-mission:<owner>/<repo>:<slug>
 *
 * The gist contains a single file `state.json` holding a StateEnvelope (same
 * shape as the issue-comment state used by mission issues — version, rev,
 * cursor, data, done). The agent never sees the rev; the writer bumps it.
 *
 * Discovery is done via `gh api /gists --paginate`. With ~tens of missions
 * per bot account this is fast and cheap (a single tick costs 1 list call
 * plus the file read).
 */

import { gh } from "../issue.js"
import {
  type StateEnvelope,
  formatStateCommentBody,
  initialStateEnvelope,
  isStateEnvelope,
  parseStateCommentBody,
} from "./issueStateComment.js"

export interface LoadedMissionGist {
  gistId: string
  state: StateEnvelope
}

/**
 * Build the canonical description string used to identify a mission's state
 * gist. Keeping it deterministic means we never need a side registry.
 */
export function gistDescription(owner: string, repo: string, slug: string): string {
  return `kody-mission:${owner}/${repo}:${slug}`
}

interface GistRecord {
  id: string
  description: string | null
  files: Record<string, { filename: string; content?: string } | undefined>
}

function listGists(cwd?: string): GistRecord[] {
  let raw = ""
  try {
    raw = gh(["api", "--paginate", "/gists?per_page=100"], { cwd })
  } catch {
    return []
  }
  // --paginate concatenates JSON arrays back-to-back; gh handles the merge
  // when the body is a single array, which it is for /gists.
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return (parsed as Array<Record<string, unknown>>)
    .filter((g) => typeof g.id === "string")
    .map((g) => ({
      id: g.id as string,
      description: typeof g.description === "string" ? (g.description as string) : null,
      files: (g.files as Record<string, { filename: string; content?: string }>) ?? {},
    }))
}

function getGist(gistId: string, cwd?: string): GistRecord | null {
  let raw = ""
  try {
    raw = gh(["api", `/gists/${gistId}`], { cwd })
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const o = parsed as Record<string, unknown>
  if (typeof o.id !== "string") return null
  return {
    id: o.id,
    description: typeof o.description === "string" ? o.description : null,
    files: (o.files as Record<string, { filename: string; content?: string }>) ?? {},
  }
}

function findGistByDescription(description: string, cwd?: string): GistRecord | null {
  const all = listGists(cwd)
  return all.find((g) => g.description === description) ?? null
}

/**
 * Pull the StateEnvelope out of a gist's `state.json` file. Tolerates
 * accidentally-stored marker-comment-format payloads by attempting both raw
 * JSON parse and the legacy marker parser before giving up.
 */
function readEnvelope(gist: GistRecord): StateEnvelope | null {
  const file = gist.files["state.json"]
  if (!file?.content) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(file.content)
  } catch {
    // Fallback: maybe an older mission stored the marker-comment format.
    const fallback = parseStateCommentBody("kody-mission-state", file.content)
    return fallback ?? null
  }
  return isStateEnvelope(parsed) ? parsed : null
}

/**
 * Find the mission's state gist. Returns `null` when no gist exists yet
 * (first-tick case) — callers should bootstrap via `createMissionGist`.
 */
export function findMissionGist(
  owner: string,
  repo: string,
  slug: string,
  cwd?: string,
): LoadedMissionGist | null {
  const desc = gistDescription(owner, repo, slug)
  const gist = findGistByDescription(desc, cwd)
  if (!gist) return null
  // Re-fetch the gist by id to guarantee we have file content (the list
  // endpoint truncates files larger than 1MB but for our payloads it returns
  // them inline; this is a belt-and-braces refresh).
  const full = getGist(gist.id, cwd) ?? gist
  const envelope = readEnvelope(full)
  if (!envelope) return null
  return { gistId: full.id, state: envelope }
}

/**
 * Create a new private gist seeded with an empty StateEnvelope. Returns the
 * loaded gist so the caller can chain it into its first state write.
 */
export function createMissionGist(
  owner: string,
  repo: string,
  slug: string,
  cursor = "seed",
  cwd?: string,
): LoadedMissionGist {
  const description = gistDescription(owner, repo, slug)
  const initial = initialStateEnvelope(cursor)
  const payload = {
    description,
    public: false,
    files: {
      "state.json": { content: JSON.stringify(initial, null, 2) + "\n" },
    },
  }
  const raw = gh(["api", "--method", "POST", "/gists", "--input", "-"], {
    cwd,
    input: JSON.stringify(payload),
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`createMissionGist: gh did not return JSON: ${raw.slice(0, 200)}`)
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { id?: unknown }).id !== "string") {
    throw new Error("createMissionGist: gist creation response missing id")
  }
  return { gistId: (parsed as { id: string }).id, state: initial }
}

/**
 * Overwrite `state.json` in the named gist with the provided envelope. Idempotent.
 */
export function writeMissionGist(gistId: string, next: StateEnvelope, cwd?: string): void {
  const payload = {
    files: {
      "state.json": { content: JSON.stringify(next, null, 2) + "\n" },
    },
  }
  gh(["api", "--method", "PATCH", `/gists/${gistId}`, "--input", "-"], {
    cwd,
    input: JSON.stringify(payload),
  })
}

// Re-export so callers don't need a second import line.
export { formatStateCommentBody }
