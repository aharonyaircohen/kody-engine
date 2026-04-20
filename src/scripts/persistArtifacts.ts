/**
 * Postflight: persist declared output artifacts into the task-state
 * comment's `artifacts` map. Reads each declared source field from ctx.data
 * (supports dotted paths) and writes a typed Artifact entry.
 *
 * Must run AFTER parseAgentResult (which populates ctx.data with the parsed
 * agent output) and BEFORE saveTaskState (which is what actually pushes the
 * comment to GitHub).
 *
 * If the source field is missing/empty, the artifact is skipped silently —
 * producer failures are already surfaced through parseAgentResult's action.
 */

import type { PostflightScript } from "../executables/types.js"
import { emptyState, setArtifact, type TaskState } from "../state.js"

export const persistArtifacts: PostflightScript = async (ctx, profile) => {
  if (profile.outputArtifacts.length === 0) return

  let state = (ctx.data.taskState as TaskState | undefined) ?? emptyState()
  const now = new Date().toISOString()

  for (const spec of profile.outputArtifacts) {
    const content = readDottedString(ctx.data, spec.from)
    if (!content) continue
    state = setArtifact(state, spec.name, {
      format: spec.format,
      producedBy: profile.name,
      createdAt: now,
      content,
    })
  }

  ctx.data.taskState = state
}

function readDottedString(source: Record<string, unknown>, dotted: string): string {
  const parts = dotted.split(".")
  let cur: unknown = source
  for (const p of parts) {
    if (cur === null || cur === undefined) return ""
    cur = (cur as Record<string, unknown>)[p]
  }
  if (typeof cur === "string") return cur
  if (cur === null || cur === undefined) return ""
  return String(cur)
}
