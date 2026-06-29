import type { AgentResult } from "../agent.js"
import type { Context, PostflightScript, Profile } from "../executables/types.js"
import { readStateText, upsertStateText } from "../stateRepo.js"

const REPORT_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export const writeResponsibilityReport: PostflightScript = async (ctx, profile, agentResult) => {
  if (ctx.data.jobSaveReport !== true) return

  try {
    writeReport(ctx, profile, agentResult)
  } catch (err) {
    fail(ctx, `writeResponsibilityReport: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function writeReport(ctx: Context, profile: Profile, agentResult: AgentResult | null): void {
  const slug = responsibilitySlug(ctx)
  if (!slug) {
    fail(ctx, "writeResponsibilityReport: missing responsibility slug")
    return
  }
  if (!REPORT_SLUG_RE.test(slug)) {
    fail(ctx, `writeResponsibilityReport: invalid responsibility slug "${slug}"`)
    return
  }

  const body = reportBody(ctx, agentResult, profile)
  if (!body.trim()) {
    fail(ctx, `writeResponsibilityReport: ${slug} produced no report output`)
    return
  }

  const filePath = `reports/${slug}.md`
  const current = readStateText(ctx.config, ctx.cwd, filePath)
  if (current?.content === body) {
    ctx.data.responsibilityReport = { slug, path: current.path, changed: false }
    return
  }

  upsertStateText(ctx.config, ctx.cwd, filePath, body, `chore(reports): refresh ${slug}`)
  ctx.data.responsibilityReport = { slug, path: filePath, changed: true }
}

function responsibilitySlug(ctx: Context): string | null {
  const candidates = [ctx.data.jobAgentResponsibility, ctx.data.agentResponsibilitySlug, ctx.data.jobSlug]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
  }
  return null
}

function reportBody(ctx: Context, agentResult: AgentResult | null, profile: Profile): string {
  const prSummary = ctx.data.prSummary
  if (typeof prSummary === "string" && prSummary.trim()) return ensureTrailingNewline(prSummary.trim())

  if (agentResult?.finalText.trim()) return ensureTrailingNewline(agentResult.finalText.trim())

  const reason = ctx.output.reason || ctx.data.agentFailureReason || agentResult?.error
  if (typeof reason === "string" && reason.trim()) {
    return `# ${profile.name}\n\nFAILED: ${reason.trim()}\n`
  }

  return ""
}

function fail(ctx: Context, reason: string): void {
  ctx.output.reason = ctx.output.reason ? `${ctx.output.reason}; ${reason}` : reason
  if (ctx.output.exitCode === 0) ctx.output.exitCode = 99
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`
}
