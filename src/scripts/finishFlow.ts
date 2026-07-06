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
import type { PostflightScript, ScriptArgs } from "../implementations/types.js"
import { parsePrNumber } from "../issue.js"
import { KODY_NAMESPACE, setKodyLabel } from "../lifecycleLabels.js"
import { type TaskState, type TaskTarget, writeTaskState } from "../state.js"

/**
 * Map a finishFlow `reason` to the terminal task-state phase + status.
 * The mirror comment header reads these fields; without an explicit
 * write here it stays frozen at the last child's "reviewing/running"
 * because no postflight rewrites the comment after the container exits.
 */
const TERMINAL_PHASE: Record<string, { phase: TaskState["core"]["phase"]; status: TaskState["core"]["status"] }> = {
  "review-passed": { phase: "shipped", status: "succeeded" },
  "fix-applied": { phase: "shipped", status: "succeeded" },
  "review-failed": { phase: "failed", status: "failed" },
  aborted: { phase: "failed", status: "failed" },
}

const API_TIMEOUT_MS = 30_000

const STATUS_ICON: Record<string, string> = {
  "review-passed": "✅",
  "fix-applied": "✅",
  "review-failed": "⚠️",
  aborted: "⚠️",
}

export const finishFlow: PostflightScript = async (ctx, profile, _agentResult, args?: ScriptArgs) => {
  const reason = (args?.reason as string | undefined) ?? "completed"
  const issueNumber = ctx.args.issue as number | undefined
  const state = ctx.data.taskState as TaskState | undefined

  // Container profiles (bug/feature/chore) drive the flow in-process via
  // runContainerLoop and never call the startFlow postflight that seeded
  // state.flow.name historically. Fall back to the orchestrator's own
  // profile name — which IS the flow name (bug → "bug" flow, feature →
  // "feature" flow). Previously rendered the placeholder "(unknown flow)"
  // on every container-driven finish.
  const flowName = state?.flow?.name || profile.name || "(unknown flow)"
  if (state) state.flow = undefined

  if (!issueNumber) return

  // Terminal label is profile-declared (via `with.label` on this entry).
  // We don't know which labels exist — we just apply what the caller asked.
  // Apply to the issue AND the PR (when one exists) so neither is left
  // stamped with a mid-flow label like `kody:reviewing`.
  const label = typeof args?.label === "string" ? args.label : undefined
  if (label?.startsWith(KODY_NAMESPACE)) {
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

  // Flip the state-mirror comment to the terminal phase/status. Without
  // this, the mirror's "📋 kody task state" header keeps showing the last
  // child's intermediate state (e.g. `Phase: reviewing, Status: running`)
  // after the container exits — users seeing the mirror conclude the flow
  // is still running even though kody:done is set and the finish comment
  // is posted. Best-effort: a failed write is logged but does not throw,
  // since the user-visible terminal label/comment are already in place.
  const terminal = TERMINAL_PHASE[reason]
  if (terminal && state) {
    state.core.phase = terminal.phase
    state.core.status = terminal.status
    state.core.currentImplementation = null
    const target = (ctx.data.commentTargetType as TaskTarget | undefined) ?? "issue"
    const targetNumber = (ctx.data.commentTargetNumber as number | undefined) ?? issueNumber
    try {
      writeTaskState(target, targetNumber, state, ctx.cwd, ctx.config)
    } catch (err) {
      process.stderr.write(
        `[kody finishFlow] failed to update state mirror: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }
}
