/**
 * Postflight: post a single user-facing comment on the triggering issue
 * derived from terminal `ctx.output` state. Templates:
 *   success + prUrl  → "✅ kody <label>: <prUrl>"
 *   success          → "✅ kody <label> complete"
 *   dry-run          → "ℹ️ kody <label> (dry-run): <reason>"
 *   failure          → "⚠️ kody <label> failed: <reason>"
 *
 * Args (from profile entry's `with` object):
 *   - label: human-readable phase label (e.g. "release prepare")
 *
 * Reads:
 *   - ctx.args.issue        — issue/PR number to comment on (required)
 *   - ctx.args.dry-run      — if truthy, dry-run template
 *   - ctx.output.exitCode   — 0 success, non-zero failure
 *   - ctx.output.prUrl      — appended to success when set
 *   - ctx.output.reason     — included in dry-run / failure templates
 *
 * Best-effort: any gh failure is logged and swallowed. Never aborts the run.
 */

import type { PostflightScript, ScriptArgs } from "../executables/types.js"
import { postIssueComment as ghPostIssueComment, truncate } from "../issue.js"

export const notifyTerminal: PostflightScript = async (ctx, _profile, _agentResult, args?: ScriptArgs) => {
  const issueNumber = ctx.args.issue as number | undefined
  if (!issueNumber || issueNumber <= 0) return

  const label = (args?.label as string | undefined) ?? "kody run"
  const dryRun = ctx.args["dry-run"] === true || ctx.args.dryRun === true
  const exit = ctx.output.exitCode ?? 0
  const reason = ctx.output.reason
  const prUrl = ctx.output.prUrl

  const body = composeBody({ label, exit, prUrl, reason, dryRun })

  try {
    ghPostIssueComment(issueNumber, body, ctx.cwd)
  } catch (err) {
    process.stderr.write(
      `[kody notifyTerminal] failed to post comment on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}

interface BodyArgs {
  label: string
  exit: number
  prUrl?: string
  reason?: string
  dryRun: boolean
}

function composeBody({ label, exit, prUrl, reason, dryRun }: BodyArgs): string {
  if (exit !== 0) {
    const suffix = prUrl ? ` — ${prUrl}` : ""
    return `⚠️ kody ${label} failed: ${truncate(reason ?? "unknown error", 1500)}${suffix}`
  }
  if (dryRun) {
    return `ℹ️ kody ${label} (dry-run): ${reason ?? "plan printed, no changes applied"}`
  }
  if (prUrl) return `✅ kody ${label}: ${prUrl}`
  return `✅ kody ${label} complete`
}
