/**
 * Postflight for `run` (and any future plan-consuming agentAction): record
 * the agent's `PLAN_DEVIATIONS:` block when present and warn when omitted
 * or malformed. NOT a hard gate — verify/tests are the real shipability
 * check; forgetting a bureaucratic checklist at the end of a long task
 * should not throw away working code.
 *
 * Must run AFTER parseAgentResult (populates planDeviations + agentDone).
 *
 * No-op when:
 *   - the agent did not reach DONE (parseAgentResult already failed),
 *   - no plan artifact was loaded (nothing to deviate from).
 */

import type { PostflightScript } from "../agent-actions/types.js"

export const requirePlanDeviations: PostflightScript = async (ctx, _profile) => {
  if (!ctx.data.agentDone) return

  const artifacts = (ctx.data.artifacts as Record<string, string> | undefined) ?? {}
  const planContent = (artifacts.plan ?? "").trim()
  if (!planContent) return // no plan was provided — nothing to enforce

  const raw = String(ctx.data.planDeviations ?? "").trim()
  if (raw.length === 0) {
    // Missing block is no longer fatal: the harness checks reality (verify,
    // tests, branch state) elsewhere. Forgetting a bureaucratic checklist
    // at the end of a long task should not throw away working code. We
    // record the omission for downstream visibility but let the run ship.
    process.stderr.write(
      "[kody requirePlanDeviations] warning: agent omitted PLAN_DEVIATIONS block — proceeding anyway (verify/tests are the real gate)\n",
    )
    ctx.data.planDeviationsOmitted = true
    return
  }

  // Accept either the sentinel `none` or a bulleted list with ≥1 item.
  if (isNoneSentinel(raw)) return

  const bullets = raw.split("\n").filter((l) => /^\s*[-*]\s+/.test(l))
  if (bullets.length === 0) {
    // Block is present but malformed (no bullets, not 'none'). Still a
    // soft warning — same reasoning as above.
    process.stderr.write(
      "[kody requirePlanDeviations] warning: PLAN_DEVIATIONS block is not 'none' and lists no bullet items — proceeding anyway\n",
    )
    ctx.data.planDeviationsMalformed = true
    return
  }

  // Record for downstream visibility.
  ctx.data.planDeviationCount = bullets.length
}

export function isNoneSentinel(block: string): boolean {
  const stripped = block
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*[-*]\s*/, "")
        .trim()
        .toLowerCase(),
    )
    .filter((l) => l.length > 0)
  if (stripped.length !== 1) return false
  return stripped[0] === "none"
}
