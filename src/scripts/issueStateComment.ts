/**
 * Durable state in a dedicated GitHub issue-comment.
 *
 * Convention: one "state comment" per marker per issue. Body starts with a
 * marker HTML comment, followed by a fenced JSON block:
 *
 *     <!-- kody-manager-state -->
 *
 *     ```json
 *     { "version": 1, "rev": 3, "cursor": "...", "data": {...}, "done": false }
 *     ```
 *
 * Everything outside the marker-led body is ignored. The issue description is
 * untouched — humans own it. Bot state lives in this one comment, minimized
 * (collapsed) via GraphQL so it stays out of the way in the GitHub UI.
 *
 * Intended to be used by any stateful kody executable, not just managers.
 */

import { gh } from "../issue.js"

export interface StateEnvelope {
  version: 1
  rev: number
  cursor: string
  data: Record<string, unknown>
  done: boolean
}

export interface LoadedStateComment {
  commentId: number
  commentNodeId: string
  state: StateEnvelope
}

export function isStateEnvelope(x: unknown): x is StateEnvelope {
  if (x === null || typeof x !== "object") return false
  const o = x as Record<string, unknown>
  return (
    o.version === 1 &&
    typeof o.rev === "number" &&
    Number.isInteger(o.rev) &&
    o.rev >= 0 &&
    typeof o.cursor === "string" &&
    typeof o.done === "boolean" &&
    o.data !== null &&
    typeof o.data === "object" &&
    !Array.isArray(o.data)
  )
}

export function initialStateEnvelope(cursor = "seed"): StateEnvelope {
  return { version: 1, rev: 0, cursor, data: {}, done: false }
}

export function formatStateCommentBody(marker: string, state: StateEnvelope): string {
  return `<!-- ${marker} -->\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n`
}

export function parseStateCommentBody(marker: string, body: string): StateEnvelope | null {
  const markerLine = `<!-- ${marker} -->`
  if (!body.trimStart().startsWith(markerLine)) return null
  const fenceOpen = body.indexOf("```json")
  if (fenceOpen === -1) return null
  const after = body.slice(fenceOpen + "```json".length)
  const fenceClose = after.indexOf("```")
  if (fenceClose === -1) return null
  const jsonText = after.slice(0, fenceClose).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  return isStateEnvelope(parsed) ? parsed : null
}

// ────────────────────────────────────────────────────────────────────────────
// I/O
// ────────────────────────────────────────────────────────────────────────────

interface CommentRecord {
  id: number
  node_id: string
  body: string
}

export function listIssueComments(owner: string, repo: string, issueNumber: number, cwd?: string): CommentRecord[] {
  const raw = gh(["api", "--paginate", `repos/${owner}/${repo}/issues/${issueNumber}/comments`], { cwd })
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return (parsed as Array<Record<string, unknown>>)
    .filter((c) => typeof c.id === "number" && typeof c.node_id === "string" && typeof c.body === "string")
    .map((c) => ({ id: c.id as number, node_id: c.node_id as string, body: c.body as string }))
}

export function findStateComment(
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
  cwd?: string,
): LoadedStateComment | null {
  const comments = listIssueComments(owner, repo, issueNumber, cwd)
  for (const c of comments) {
    const state = parseStateCommentBody(marker, c.body)
    if (!state) continue
    return { commentId: c.id, commentNodeId: c.node_id, state }
  }
  return null
}

export function createStateComment(
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
  state: StateEnvelope,
  cwd?: string,
): LoadedStateComment {
  const body = formatStateCommentBody(marker, state)
  const raw = gh(["api", "--method", "POST", `repos/${owner}/${repo}/issues/${issueNumber}/comments`, "--input", "-"], {
    cwd,
    input: JSON.stringify({ body }),
  })
  const parsed = JSON.parse(raw) as CommentRecord
  try {
    minimizeComment(parsed.node_id, cwd)
  } catch {
    /* best-effort; leave it expanded if minimizeComment fails */
  }
  return { commentId: parsed.id, commentNodeId: parsed.node_id, state }
}

export function updateStateComment(
  owner: string,
  repo: string,
  commentId: number,
  commentNodeId: string,
  marker: string,
  state: StateEnvelope,
  cwd?: string,
): void {
  const body = formatStateCommentBody(marker, state)
  gh(["api", "--method", "PATCH", `repos/${owner}/${repo}/issues/comments/${commentId}`, "--input", "-"], {
    cwd,
    input: JSON.stringify({ body }),
  })
  try {
    minimizeComment(commentNodeId, cwd)
  } catch {
    /* best-effort */
  }
}

/**
 * Collapse a comment via GraphQL. Idempotent on already-minimized comments.
 */
export function minimizeComment(nodeId: string, cwd?: string): void {
  const mutation =
    "mutation($id: ID!) { minimizeComment(input: { classifier: OUTDATED, subjectId: $id }) { minimizedComment { isMinimized } } }"
  gh(["api", "graphql", "-f", `query=${mutation}`, "-f", `id=${nodeId}`], { cwd })
}
