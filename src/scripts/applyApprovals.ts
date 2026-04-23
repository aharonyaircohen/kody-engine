/**
 * Postflight (approve-executable only): respond to `@kody2 approve` by
 * posting a confirmation comment and re-triggering the paused flow.
 *
 * The durable approval signal IS the user's `@kody2 approve` comment
 * itself — riskGate scans comments on the target (and originating issue)
 * for `@kody2 approve` posted after the latest advisory and treats that
 * as approval. No labels are written; `kody:waiting` clears naturally
 * when the next primitive's preflight sets its own `kody:<step>` label
 * (same mutex group).
 *
 * Re-trigger:
 *   - If task state has `flow.name` → `@kody2 <flow.name>` on the issue.
 *   - Else → no re-trigger (user can post `@kody2 <cmd>` manually).
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript } from "../executables/types.js"
import { postIssueComment, postPrReviewComment } from "../issue.js"
import { readTaskState, type TaskState } from "../state.js"

const API_TIMEOUT_MS = 30_000

export const applyApprovals: PostflightScript = async (ctx) => {
  const issueArg = typeof ctx.args.issue === "number" ? (ctx.args.issue as number) : null
  const prArg = typeof ctx.args.pr === "number" ? (ctx.args.pr as number) : null

  const currentTarget: { type: "issue" | "pr"; number: number } | null = issueArg
    ? { type: "issue", number: issueArg }
    : prArg
      ? { type: "pr", number: prArg }
      : null

  if (!currentTarget) {
    ctx.output.exitCode = 64
    ctx.output.reason = "approve: must be invoked with --issue or --pr"
    return
  }

  let state: TaskState | null = null
  try {
    state = readTaskState(currentTarget.type, currentTarget.number, ctx.cwd)
  } catch {
    state = null
  }

  const issueNumber = currentTarget.type === "issue" ? currentTarget.number : state?.flow?.issueNumber ?? null
  const flowName = state?.flow?.name ?? null

  const confirmation = formatConfirmation(currentTarget, flowName, issueNumber)
  try {
    if (currentTarget.type === "issue") postIssueComment(currentTarget.number, confirmation, ctx.cwd)
    else postPrReviewComment(currentTarget.number, confirmation, ctx.cwd)
  } catch {
    /* best effort */
  }

  // Re-trigger the paused flow on the issue so the orchestrator picks up
  // where it left off. Without a known flow.name we can't safely guess.
  if (issueNumber && typeof flowName === "string" && flowName.length > 0) {
    try {
      execFileSync("gh", ["issue", "comment", String(issueNumber), "--body", `@kody2 ${flowName}`], {
        timeout: API_TIMEOUT_MS,
        cwd: ctx.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      process.stderr.write(
        `[kody2 approve] failed to re-trigger flow on issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  ctx.output.exitCode = 0
}

function formatConfirmation(
  current: { type: "issue" | "pr"; number: number },
  flowName: string | null,
  issueNumber: number | null,
): string {
  const lines: string[] = []
  lines.push("✅ **kody2 risk gates approved.**")
  lines.push("")
  lines.push("The approval is recorded as this comment — kody2 reads it directly on the next run.")
  if (flowName && issueNumber) {
    lines.push("")
    if (current.type === "pr") {
      lines.push(
        `Re-triggering the \`${flowName}\` flow on the originating issue (#${issueNumber}) — it will resume from the existing branch/PR checkpoint.`,
      )
    } else {
      lines.push(`Re-triggering the \`${flowName}\` flow now — it will resume from the existing branch checkpoint.`)
    }
  } else {
    lines.push("")
    lines.push("No active flow found in task state. Post `@kody2 <command>` to resume manually.")
  }
  return lines.join("\n")
}
