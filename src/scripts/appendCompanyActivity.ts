/**
 * Postflight: append a Company Activity record for an capability tick.
 *
 * The activity feed is Kody runtime state persisted by the backend.
 */

import { getRunUrl } from "../gha.js"
import type { PostflightScript } from "../implementations/types.js"
import { createStateBackendFromEnv } from "../state-backend.js"

interface ActivityRecord {
  ts: string
  action: string
  capability: string
  capabilityTitle: string | null
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

async function appendActivity(ctx: Parameters<PostflightScript>[0], record: ActivityRecord): Promise<void> {
  const tenantId =
    ctx.config.github?.owner && ctx.config.github.repo
      ? `${ctx.config.github.owner}/${ctx.config.github.repo}`
      : process.env.GITHUB_REPOSITORY
  if (process.env.CONVEX_URL?.trim() && process.env.KODY_SERVICE_KEY?.trim() && tenantId) {
    await createStateBackendFromEnv().appendDailyLog(tenantId, "activity", record.ts.slice(0, 10), record)
    return
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error("Convex backend is required for company activity in GitHub Actions")
  }
}

export const appendCompanyActivity: PostflightScript = async (ctx, _profile, agentResult) => {
  try {
    const capability = String(ctx.data.jobSlug ?? ctx.args?.job ?? "").trim()
    if (!capability) return

    const capabilityTitle = (ctx.data.jobTitle as string | undefined) ?? null
    const agent = (ctx.data.agentSlug as string | undefined) || null
    const agentTitle = (ctx.data.agentTitle as string | undefined) || null
    const force = ctx.args?.force === true

    const record: ActivityRecord = {
      ts: new Date().toISOString(),
      action: `Ran capability: ${capabilityTitle ?? capability}`,
      capability,
      capabilityTitle,
      agent,
      agentTitle,
      trigger: resolveTrigger(force),
      outcome: agentResult?.outcome ?? "unknown",
      outcomeKind: agentResult?.outcomeKind ?? null,
      reason: agentResult?.error ?? null,
      durationMs: agentResult?.durationMs ?? null,
      runUrl: getRunUrl() || null,
    }

    await appendActivity(ctx, record)
  } catch (err) {
    process.stderr.write(
      `[activity] company-activity append failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}
