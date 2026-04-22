/**
 * Postflight for `run` (and any future plan-consuming executable): enforce
 * that when an input `plan` artifact was provided, the agent's final message
 * includes an explicit `PLAN_DEVIATIONS:` section — either the sentinel
 * `- none` or a bulleted list of deviations.
 *
 * Without this, the agent can silently depart from the plan (different file
 * names, different function names, missing pieces) without flagging it,
 * which defeats the plan→run handoff contract.
 *
 * Must run AFTER parseAgentResult (populates planDeviations + agentDone)
 * and BEFORE commitAndPush (so a silent deviation blocks the commit).
 *
 * No-op when:
 *   - the agent did not reach DONE (parseAgentResult already failed),
 *   - no plan artifact was loaded (nothing to deviate from).
 */

import type { PostflightScript } from "../executables/types.js"
import type { Action } from "../state.js"

export const requirePlanDeviations: PostflightScript = async (ctx, profile) => {
  if (!ctx.data.agentDone) return

  const artifacts = (ctx.data.artifacts as Record<string, string> | undefined) ?? {}
  const planContent = (artifacts.plan ?? "").trim()
  if (!planContent) return // no plan was provided — nothing to enforce

  const raw = String(ctx.data.planDeviations ?? "").trim()
  if (raw.length === 0) {
    fail(ctx, profile, "agent omitted required PLAN_DEVIATIONS block — cannot verify whether the plan was followed")
    return
  }

  // Accept either the sentinel `none` or a bulleted list with ≥1 item.
  if (isNoneSentinel(raw)) return

  const bullets = raw.split("\n").filter((l) => /^\s*[-*]\s+/.test(l))
  if (bullets.length === 0) {
    fail(ctx, profile, "agent PLAN_DEVIATIONS block is not 'none' and lists no bullet items")
    return
  }

  // Record for downstream visibility.
  ctx.data.planDeviationCount = bullets.length
}

export function isNoneSentinel(block: string): boolean {
  const stripped = block
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim().toLowerCase())
    .filter((l) => l.length > 0)
  if (stripped.length !== 1) return false
  return stripped[0] === "none"
}

function fail(
  ctx: Parameters<PostflightScript>[0],
  profile: Parameters<PostflightScript>[1],
  reason: string,
): void {
  ctx.data.agentDone = false
  ctx.data.agentFailureReason = reason
  const modeSeg = profile.name.replace(/-/g, "_").toUpperCase()
  const failedAction: Action = {
    type: `${modeSeg}_FAILED`,
    payload: { reason },
    timestamp: new Date().toISOString(),
  }
  ctx.data.action = failedAction
}
