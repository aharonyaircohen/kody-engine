/**
 * Postflight: append a Company Activity record for an agent responsibility tick.
 *
 * The activity feed is Kody runtime state, so it lives in the configured state
 * repo under `activity/<YYYY-MM-DD>.jsonl`.
 */
import type { PostflightScript } from "../agent-actions/types.js"
import { getRunUrl } from "../gha.js"
import { appendStateLine } from "../stateRepo.js"

interface ActivityRecord {
  ts: string
  action: string
  agentResponsibility: string
  agentResponsibilityTitle: string | null
  agent: string | null
  agentTitle: string | null
  trigger: "schedule" | "manual" | "event"
  outcome: "completed" | "failed" | "unknown"
  /** Structured failure kind: stalled, out_of_turns, rate_limit, tool_error, etc. */
  outcomeKind: string | null
  /** Short human-readable failure message. */
  reason: string | null
  durationMs: number | null
  runUrl: string | null
}

function resolveTrigger(force: boolean): ActivityRecord["trigger"] {
  const event = process.env.GITHUB_EVENT_NAME ?? ""
  if (event === "schedule") return "schedule"
  if (force || event === "issue_comment" || event === "workflow_dispatch") return "manual"
  return "event"
}

function appendLine(ctx: Parameters<PostflightScript>[0], record: ActivityRecord): void {
  const filePath = `activity/${record.ts.slice(0, 10)}.jsonl`
  appendStateLine(ctx.config, ctx.cwd, filePath, JSON.stringify(record), `chore(activity): ${record.action}`)
}

export const appendCompanyActivity: PostflightScript = async (ctx, _profile, agentResult) => {
  try {
    const agentResponsibility = String(ctx.data.jobSlug ?? ctx.args?.job ?? "").trim()
    if (!agentResponsibility) return

    const agentResponsibilityTitle = (ctx.data.jobTitle as string | undefined) ?? null
    const agent = (ctx.data.agentSlug as string | undefined) || null
    const agentTitle = (ctx.data.agentTitle as string | undefined) || null
    const force = ctx.args?.force === true

    const record: ActivityRecord = {
      ts: new Date().toISOString(),
      action: `Ran agentResponsibility: ${agentResponsibilityTitle ?? agentResponsibility}`,
      agentResponsibility,
      agentResponsibilityTitle,
      agent,
      agentTitle,
      trigger: resolveTrigger(force),
      outcome: agentResult?.outcome ?? "unknown",
      outcomeKind: agentResult?.outcomeKind ?? null,
      reason: agentResult?.error ?? null,
      durationMs: agentResult?.durationMs ?? null,
      runUrl: getRunUrl() || null,
    }

    appendLine(ctx, record)
  } catch (err) {
    process.stderr.write(
      `[activity] company-activity append failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}
