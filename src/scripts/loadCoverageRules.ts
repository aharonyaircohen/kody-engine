/**
 * Shared preflight: expose the kody.config.json testRequirements in context.
 * The composePrompt and checkCoverageWithRetry scripts consume ctx.data.coverageRules.
 */

import type { PreflightScript } from "../agent-actions/types.js"

export const loadCoverageRules: PreflightScript = async (ctx) => {
  // Phase 5 fast path: container handed us pre-loaded rules.
  if (Array.isArray(ctx.data.coverageRules)) return
  ctx.data.coverageRules = ctx.config.testRequirements ?? []
}
