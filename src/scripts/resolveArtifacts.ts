/**
 * Preflight: resolve declared input artifacts from the task-state comment
 * into ctx.data.artifacts, so composePrompt can render them via
 * {{artifacts.<name>}} tokens.
 *
 * Depends on loadTaskState having populated ctx.data.taskState.
 *
 * If a required artifact is missing, we set ctx.skipAgent + a failure reason
 * so the executable fails fast instead of invoking the agent without context.
 */

import type { PreflightScript } from "../executables/types.js"
import type { TaskState } from "../state.js"

export const resolveArtifacts: PreflightScript = async (ctx, profile) => {
  if (profile.inputArtifacts.length === 0) return

  const state = ctx.data.taskState as TaskState | undefined
  const available = state?.artifacts ?? {}

  const resolved: Record<string, string> = {}
  const missing: string[] = []

  for (const spec of profile.inputArtifacts) {
    const found = available[spec.name]
    if (found && typeof found.content === "string") {
      resolved[spec.name] = found.content
    } else if (spec.required) {
      missing.push(spec.name)
    }
  }

  ctx.data.artifacts = resolved

  if (missing.length > 0) {
    ctx.skipAgent = true
    ctx.output.exitCode = 64
    ctx.output.reason = `required input artifacts missing from task state: ${missing.join(", ")}`
  }
}
