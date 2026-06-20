import type { AgentResult } from "../agent.js"
import { applyDutyReportToGoalState, type DutyReport, parseDutyReportsFromText } from "../dutyReport.js"
import type { PostflightScript } from "../executables/types.js"
import { nowIso, serializeGoalState } from "../goal/state.js"
import { fetchGoalState, putGoalState } from "../goal/stateStore.js"

export const applyDutyReports: PostflightScript = async (ctx, _profile, agentResult) => {
  const reports = collectReports(ctx.data.dutyReports, agentResult)
  if (reports.length === 0) return

  const owner = ctx.config.github?.owner
  const repo = ctx.config.github?.repo
  if (!owner || !repo) {
    process.stderr.write("[kody duty-report] missing github owner/repo; cannot apply reports\n")
    return
  }

  const goalReports = reports.filter((report) => report.target.type === "goal")
  for (const report of goalReports) {
    const prior = fetchGoalState(owner, repo, report.target.id, ctx.cwd)
    if (!prior) {
      process.stderr.write(`[kody duty-report] goal ${report.target.id} missing on kody-state; report skipped\n`)
      continue
    }
    const next = applyDutyReportToGoalState(prior, report)
    if (serializeGoalState(next) === serializeGoalState(prior)) continue
    putGoalState(owner, repo, report.target.id, { ...next, updatedAt: nowIso() }, describeMessage(report), ctx.cwd)
  }
}

function collectReports(raw: unknown, agentResult: AgentResult | null): DutyReport[] {
  const out: DutyReport[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (isDutyReport(item)) out.push(item)
    }
  }
  if (agentResult?.finalText) out.push(...parseDutyReportsFromText(agentResult.finalText))
  return out
}

function isDutyReport(raw: unknown): raw is DutyReport {
  return (
    !!raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    !!(raw as DutyReport).target &&
    ((raw as DutyReport).target.type === "goal" ||
      (raw as DutyReport).target.type === "task" ||
      (raw as DutyReport).target.type === "duty") &&
    typeof (raw as DutyReport).target.id === "string"
  )
}

function describeMessage(report: DutyReport): string {
  const keys = [
    ...Object.keys(report.evidence ?? {}).map((key) => `evidence:${key}`),
    ...Object.keys(report.facts ?? {}).map((key) => `fact:${key}`),
  ]
  return `chore(goals): apply duty report for ${report.target.id}${keys.length ? ` (${keys.join(", ")})` : ""}`
}
