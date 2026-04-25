/**
 * Postflight (release orchestrator only): merge the release PR opened by
 * release-prepare into the default branch, then record an Action so the
 * orchestrator's transition table can advance.
 *
 * Reads:
 *   - ctx.data.taskState.core.prUrl  — set by release-prepare's saveTaskState
 *
 * Writes:
 *   - ctx.data.action — RELEASE_MERGE_COMPLETED on success
 *                       RELEASE_MERGE_FAILED   on failure (no prUrl, gh error)
 *   - mutates state.core.lastOutcome in-place so subsequent runWhen entries
 *     in the same postflight pass see the new outcome
 *
 * Idempotent: if the PR is already merged (gh returns "Pull request … is
 * already merged"), the Action is COMPLETED — re-runs after a manual merge
 * resume the chain instead of stalling.
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript } from "../executables/types.js"
import type { Action, TaskState } from "../state.js"

const API_TIMEOUT_MS = 60_000

export const mergeReleasePr: PostflightScript = async (ctx) => {
  const state = ctx.data.taskState as TaskState | undefined
  const prUrl = state?.core.prUrl
  if (!prUrl) {
    ctx.data.action = makeAction("RELEASE_MERGE_FAILED", { reason: "no prUrl on task state" })
    if (state) state.core.lastOutcome = ctx.data.action as Action
    return
  }

  const prNumber = parsePrNumber(prUrl)
  if (!prNumber) {
    ctx.data.action = makeAction("RELEASE_MERGE_FAILED", { reason: `cannot parse PR number from ${prUrl}` })
    if (state) state.core.lastOutcome = ctx.data.action as Action
    return
  }

  try {
    execFileSync("gh", ["pr", "merge", String(prNumber), "--merge"], {
      timeout: API_TIMEOUT_MS,
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/already merged/i.test(msg)) {
      ctx.data.action = makeAction("RELEASE_MERGE_COMPLETED", { prUrl, alreadyMerged: true })
      if (state) state.core.lastOutcome = ctx.data.action as Action
      return
    }
    ctx.data.action = makeAction("RELEASE_MERGE_FAILED", { reason: msg, prUrl })
    if (state) state.core.lastOutcome = ctx.data.action as Action
    return
  }

  ctx.data.action = makeAction("RELEASE_MERGE_COMPLETED", { prUrl })
  if (state) state.core.lastOutcome = ctx.data.action as Action
}

function makeAction(type: string, payload: Record<string, unknown>): Action {
  return { type, payload, timestamp: new Date().toISOString() }
}

function parsePrNumber(prUrl: string): number | null {
  const m = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : null
}
