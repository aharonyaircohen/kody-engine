/**
 * Postflight (orchestrator-only): clear `state.flow` and post a final
 * human-readable summary on the issue. Used as the terminal transition for
 * both success and failure.
 *
 * Args (from profile entry's `with` object):
 *   - reason: short tag describing the terminus, e.g. "review-passed",
 *             "review-failed", "fix-applied", "aborted". Surfaced in the
 *             summary comment so users can read why the flow ended.
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript, ScriptArgs } from "../executables/types.js"
import { parsePrNumber } from "../issue.js"
import { KODY_NAMESPACE, setKodyLabel } from "../lifecycleLabels.js"
import type { TaskState } from "../state.js"

const API_TIMEOUT_MS = 30_000

const STATUS_ICON: Record<string, string> = {
  "review-passed": "✅",
  "fix-applied": "✅",
  "review-failed": "⚠️",
  aborted: "⚠️",
}

export const finishFlow: PostflightScript = async (ctx, _profile, _agentResult, args?: ScriptArgs) => {
  const reason = (args?.reason as string | undefined) ?? "completed"
  const issueNumber = ctx.args.issue as number | undefined
  const state = ctx.data.taskState as TaskState | undefined

  const flowName = state?.flow?.name ?? "(unknown flow)"
  if (state) state.flow = undefined

  if (!issueNumber) return

  // Terminal label is profile-declared (via `with.label` on this entry).
  // We don't know which labels exist — we just apply what the caller asked.
  // Apply to the issue AND the PR (when one exists) so neither is left
  // stamped with a mid-flow label like `kody:reviewing`.
  const label = typeof args?.label === "string" ? args.label : undefined
  if (label && label.startsWith(KODY_NAMESPACE)) {
    const spec = {
      label,
      color: typeof args?.color === "string" ? args.color : undefined,
      description: typeof args?.description === "string" ? args.description : undefined,
    }
    setKodyLabel(issueNumber, spec, ctx.cwd)
    const prNumber = state?.core.prUrl ? parsePrNumber(state.core.prUrl) : null
    if (prNumber && prNumber !== issueNumber) {
      setKodyLabel(prNumber, spec, ctx.cwd)
    }
  }

  const icon = STATUS_ICON[reason] ?? "ℹ️"
  const prSuffix = state?.core.prUrl ? `\n\n**PR:** ${state.core.prUrl}` : ""
  const body = `${icon} kody flow \`${flowName}\` finished — \`${reason}\`${prSuffix}`

  try {
    execFileSync("gh", ["issue", "comment", String(issueNumber), "--body", body], {
      timeout: API_TIMEOUT_MS,
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    process.stderr.write(
      `[kody finishFlow] failed to post final summary on issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}
