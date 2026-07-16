import type { Context } from "./implementations/types.js"

type RuntimeCleanup = () => void

function registeredCleanup(ctx: Context): RuntimeCleanup[] {
  return Array.isArray(ctx.data.__runtimeCleanup) ? (ctx.data.__runtimeCleanup as RuntimeCleanup[]) : []
}

export function registerRuntimeCleanup(ctx: Context, cleanup: RuntimeCleanup): void {
  ctx.data.__runtimeCleanup = [...registeredCleanup(ctx), cleanup]
}

export function runRuntimeCleanup(ctx: Context): void {
  const callbacks = registeredCleanup(ctx)
  delete ctx.data.__runtimeCleanup
  for (const cleanup of callbacks.reverse()) {
    try {
      cleanup()
    } catch {
      // Cleanup is best effort and must not hide the run's real outcome.
    }
  }
}
