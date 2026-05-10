/**
 * Preflight (runWhen state==="active"): lazy-create the goal-runner
 * dedup labels (`goal-runner:dispatched`, `goal-runner:failed`) and
 * the per-goal `goal:<id>` label so downstream scripts can rely on
 * them existing. Best-effort: failures are logged but don't bail.
 */

import type { PreflightScript } from "../executables/types.js"
import { goalLabel, TICK_LABELS, UMBRELLA_BUILDING_LABEL } from "../goal/labels.js"
import { ensureLabel } from "../goal/operations.js"
import type { GoalCtx } from "./goalCtx.js"

export const ensureLifecycleLabels: PreflightScript = async (ctx) => {
  const goal = ctx.data.goal as GoalCtx | undefined
  if (!goal) return

  for (const spec of TICK_LABELS) {
    const r = ensureLabel(spec.name, spec.color, spec.description, ctx.cwd)
    if (!r.ok) {
      process.stderr.write(`[goal-tick] ensureLifecycleLabels: ${spec.name}: ${r.error}\n`)
    }
  }

  const goalLbl = goalLabel(goal.id)
  const r = ensureLabel(goalLbl, "0e8a16", `kody goal task: belongs to goal ${goal.id}`, ctx.cwd)
  if (!r.ok) {
    process.stderr.write(`[goal-tick] ensureLifecycleLabels: ${goalLbl}: ${r.error}\n`)
  }

  const u = ensureLabel(
    UMBRELLA_BUILDING_LABEL,
    "1d76db",
    "kody: in-flight (work being assembled on a branch)",
    ctx.cwd,
  )
  if (!u.ok) {
    process.stderr.write(`[goal-tick] ensureLifecycleLabels: ${UMBRELLA_BUILDING_LABEL}: ${u.error}\n`)
  }
}
