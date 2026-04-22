/**
 * Preflight: flip ctx.skipAgent so the executor bypasses the agent
 * invocation and runs straight into postflight. Used by orchestrator-style
 * executables whose work is pure script composition.
 */

import type { PreflightScript } from "../executables/types.js"

export const skipAgent: PreflightScript = async (ctx) => {
  ctx.skipAgent = true
}
