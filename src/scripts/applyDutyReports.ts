import type { AgentResult } from "../agent.js"
import {
  applyDutyReportToGoalState,
  type DutyReport,
  parseDutyReport,
  parseDutyReportsFromText,
} from "../dutyReport.js"
import {
  applyDutyResultToObjectiveState,
  type DutyResult,
  parseDutyResult,
  parseDutyResultsFromText,
} from "../dutyResult.js"
import type { PostflightScript } from "../executables/types.js"
import { nowIso, serializeGoalState, type GoalState } from "../goal/state.js"
import { fetchGoalState, putGoalState } from "../goal/stateStore.js"

export const applyDutyReports: PostflightScript = async (ctx, _profile, agentResult) => {
  const reports = collectReports(ctx.data.dutyReports, agentResult)
  const results = collectResults(ctx.data.dutyResults, agentResult)
  const resultGoalId = typeof ctx.args.goal === "string" && ctx.args.goal.length > 0 ? ctx.args.goal : null
  if (reports.length === 0 && (results.length === 0 || !resultGoalId)) return

  const owner = ctx.config.github?.owner
  const repo = ctx.config.github?.repo
  if (!owner || !repo) {
    process.stderr.write("[kody duty-report] missing github owner/repo; cannot apply reports\n")
    return
  }

  const reportsByGoal = groupGoalReports(reports)
  const goalIds = new Set(reportsByGoal.keys())
  if (results.length > 0 && resultGoalId) goalIds.add(resultGoalId)

  for (const goalId of goalIds) {
    const prior = fetchGoalState(owner, repo, goalId, ctx.cwd)
    if (!prior) {
      process.stderr.write(`[kody duty-report] goal ${goalId} missing on kody-state; report skipped\n`)
      continue
    }

    let next: GoalState = prior
    for (const report of reportsByGoal.get(goalId) ?? []) {
      next = applyDutyReportToGoalState(next, report)
    }
    if (goalId === resultGoalId) {
      const evidence =
        typeof ctx.args.evidence === "string" && ctx.args.evidence.length > 0 ? ctx.args.evidence : undefined
      for (const result of results) {
        next = applyDutyResultToObjectiveState(next, result, evidence)
      }
    }

    if (serializeGoalState(next) === serializeGoalState(prior)) continue
    putGoalState(
      owner,
      repo,
      goalId,
      { ...next, updatedAt: nowIso() },
      describeMessage(goalId, reportsByGoal.get(goalId), results),
      ctx.cwd,
    )
  }
}

function collectReports(raw: unknown, agentResult: AgentResult | null): DutyReport[] {
  const out: DutyReport[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = parseDutyReport(item)
      if (parsed) out.push(parsed)
    }
  }
  if (agentResult?.finalText) out.push(...parseDutyReportsFromText(agentResult.finalText))
  return out
}

function collectResults(raw: unknown, agentResult: AgentResult | null): DutyResult[] {
  const out: DutyResult[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = parseDutyResult(item)
      if (parsed) out.push(parsed)
    }
  }
  if (agentResult?.finalText) out.push(...parseDutyResultsFromText(agentResult.finalText))
  return out
}

function groupGoalReports(reports: DutyReport[]): Map<string, DutyReport[]> {
  const grouped = new Map<string, DutyReport[]>()
  for (const report of reports) {
    if (report.target.type !== "goal") continue
    const list = grouped.get(report.target.id) ?? []
    list.push(report)
    grouped.set(report.target.id, list)
  }
  return grouped
}

function describeMessage(goalId: string, reports: DutyReport[] | undefined, results: DutyResult[]): string {
  const pieces: string[] = []
  if (reports && reports.length > 0) pieces.push(`report=${reports.length}`)
  if (results.length > 0) pieces.push(`result=${results.map((result) => result.status).join(",")}`)
  return `Apply duty output to ${goalId}${pieces.length > 0 ? ` (${pieces.join("; ")})` : ""}`
}
