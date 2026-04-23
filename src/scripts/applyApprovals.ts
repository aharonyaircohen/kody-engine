/**
 * Postflight (approve-executable only): write `kody-approve:*` labels to the
 * originating issue AND the PR (if both are discoverable), then post
 * `@kody2 <flow.name>` on the issue to resume the paused flow.
 *
 * Invoked by `@kody2 approve` — dispatch routes that comment to this
 * executable on either the issue or the PR. This script reads the task
 * state of the current target to find the "other" side of the pair so a
 * single approve action unblocks both primitives (run on the issue, fix on
 * the PR).
 *
 * Labels applied (blanket — approves both soft and hard gates, since the
 * user is explicitly typing `@kody2 approve` after reading the advisory):
 *   - kody-approve:all
 *   - kody-approve:<each known gate name>
 *
 * Re-trigger:
 *   - If task state has `flow.name` → `@kody2 <flow.name>` on the issue.
 *   - Else → best-effort no re-trigger (user can post @kody2 <cmd> manually).
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript } from "../executables/types.js"
import { gh, postIssueComment, postPrReviewComment } from "../issue.js"
import { readTaskState, type TaskState } from "../state.js"

const API_TIMEOUT_MS = 30_000

const ALL_APPROVE_LABELS: Array<{ label: string; description: string }> = [
  { label: "kody-approve:all", description: "kody2: approve all soft risk gates" },
  { label: "kody-approve:secrets", description: "kody2: approve the secrets risk gate and resume the flow" },
  { label: "kody-approve:workflow-edit", description: "kody2: approve the workflow-edit risk gate and resume the flow" },
  { label: "kody-approve:large-diff", description: "kody2: approve the large-diff risk gate and resume the flow" },
  { label: "kody-approve:dep-change", description: "kody2: approve the dep-change risk gate and resume the flow" },
  { label: "kody-approve:test-deletion", description: "kody2: approve the test-deletion risk gate and resume the flow" },
]

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

  // Find the "other" target by reading task state.
  let state: TaskState | null = null
  try {
    state = readTaskState(currentTarget.type, currentTarget.number, ctx.cwd)
  } catch {
    state = null
  }

  const issueNumber = currentTarget.type === "issue" ? currentTarget.number : state?.flow?.issueNumber ?? null
  const prNumber = currentTarget.type === "pr" ? currentTarget.number : parsePrNumber(state?.core?.prUrl)

  const targets = uniquePairs(
    [
      { type: "issue" as const, number: issueNumber },
      { type: "pr" as const, number: prNumber },
    ].filter((t): t is { type: "issue" | "pr"; number: number } => typeof t.number === "number" && t.number > 0),
  )

  // Ensure every approve label exists in the repo, then apply them to each
  // target. Best-effort per call; failures never crash the executable.
  for (const spec of ALL_APPROVE_LABELS) {
    ensureLabel(spec, ctx.cwd)
  }
  for (const t of targets) {
    for (const spec of ALL_APPROVE_LABELS) {
      addLabel(t.number, spec.label, ctx.cwd)
    }
  }

  // Confirmation comment on whichever surface the user approved on.
  const confirmation = formatConfirmation(currentTarget, targets, state)
  try {
    if (currentTarget.type === "issue") postIssueComment(currentTarget.number, confirmation, ctx.cwd)
    else postPrReviewComment(currentTarget.number, confirmation, ctx.cwd)
  } catch {
    /* best effort */
  }

  // Re-trigger the paused flow on the issue so the orchestrator picks up
  // where it left off. Without a known flow.name we can't safely guess.
  const flowName = state?.flow?.name
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

function parsePrNumber(url: string | undefined | null): number | null {
  if (!url) return null
  const m = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : null
}

function uniquePairs(pairs: Array<{ type: "issue" | "pr"; number: number }>): typeof pairs {
  const seen = new Set<string>()
  const out: typeof pairs = []
  for (const p of pairs) {
    const key = `${p.type}:${p.number}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

function ensureLabel(spec: { label: string; description: string }, cwd: string): void {
  try {
    gh(
      ["label", "create", spec.label, "--force", "--color", "0e8a16", "--description", spec.description],
      { cwd },
    )
  } catch {
    /* best effort — label may already exist; gh --force makes this idempotent */
  }
}

function addLabel(number: number, label: string, cwd: string): void {
  try {
    gh(["issue", "edit", String(number), "--add-label", label], { cwd })
  } catch {
    /* best effort */
  }
}

function formatConfirmation(
  current: { type: "issue" | "pr"; number: number },
  targets: Array<{ type: "issue" | "pr"; number: number }>,
  state: TaskState | null,
): string {
  const other = targets.find((t) => t.type !== current.type)
  const lines: string[] = []
  lines.push("✅ **kody2 risk gates approved.**")
  lines.push("")
  lines.push(
    `Applied \`kody-approve:*\` labels on ${targets
      .map((t) => `${t.type} #${t.number}`)
      .join(" and ")}.`,
  )
  if (other && current.type === "pr") {
    lines.push(`Mirrored to the originating issue (#${other.number}) so the orchestrator also sees the approval.`)
  } else if (other && current.type === "issue") {
    lines.push(`Mirrored to PR #${other.number} so a pending \`fix\` primitive also passes the gate.`)
  }
  const flowName = state?.flow?.name
  if (flowName) {
    lines.push("")
    lines.push(`Re-triggering the \`${flowName}\` flow now — it will resume from the existing branch/PR checkpoint.`)
  } else {
    lines.push("")
    lines.push("No active flow found in task state. Post `@kody2 <command>` to resume manually.")
  }
  return lines.join("\n")
}
