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
  const icon = STATUS_ICON[reason] ?? "ℹ️"
  const prSuffix = state?.core.prUrl ? `\n\n**PR:** ${state.core.prUrl}` : ""
  const body = `${icon} kody2 flow \`${flowName}\` finished — \`${reason}\`${prSuffix}`

  try {
    execFileSync("gh", ["issue", "comment", String(issueNumber), "--body", body], {
      timeout: API_TIMEOUT_MS,
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    process.stderr.write(
      `[kody2 finishFlow] failed to post final summary on issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}
