/**
 * Postflight: synthesize a typed Action from `ctx.output.exitCode` and stash
 * it as `ctx.data.action` so saveTaskState writes the right `lastOutcome`
 * for shell-only executables (no agent → no parseAgentResult).
 *
 * Outcome type is derived from the executable's profile name:
 *   release-prepare → RELEASE_PREPARE_COMPLETED  (exit 0)
 *                   → RELEASE_PREPARE_FAILED     (non-zero)
 *
 * That keeps each shell-only sibling's outcome name self-describing and
 * lines up with the orchestrator's `runWhen` against `lastOutcome.type`.
 */

import type { PostflightScript } from "../executables/types.js"
import type { Action } from "../state.js"

export const recordOutcome: PostflightScript = async (ctx, profile) => {
  const seg = profile.name.replace(/-/g, "_").toUpperCase()
  const ok = (ctx.output.exitCode ?? 0) === 0
  const action: Action = {
    type: ok ? `${seg}_COMPLETED` : `${seg}_FAILED`,
    payload: {
      exitCode: ctx.output.exitCode ?? 0,
      reason: ctx.output.reason,
      prUrl: ctx.output.prUrl,
    },
    timestamp: new Date().toISOString(),
  }
  ctx.data.action = action
}
