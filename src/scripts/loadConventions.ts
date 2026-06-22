/**
 * Shared preflight: load AGENTS.md / CLAUDE.md into context.
 */

import type { PreflightScript } from "../agent-actions/types.js"
import { loadProjectConventions } from "../prompt.js"

export const loadConventions: PreflightScript = async (ctx) => {
  // Phase 5 fast path: container handed us pre-loaded conventions.
  if (Array.isArray(ctx.data.conventions)) return

  const conventions = loadProjectConventions(ctx.cwd)
  ctx.data.conventions = conventions
  if (conventions.length > 0) {
    process.stderr.write(`[kody] loaded conventions: ${conventions.map((c) => c.path).join(", ")}\n`)
  }
}
