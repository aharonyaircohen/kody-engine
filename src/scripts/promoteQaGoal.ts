/**
 * Preflight for the `qa-goal` verb — the operator-gated half of QA.
 *
 * QA runs (qa-engineer dispatched by the qa / qa-sweep / approval-gate capabilities)
 * now only POST their report on the tracking issue; they never auto-create the
 * goal. The capability surfaces an inbox rec carrying `@kody qa-goal --issue <n>`.
 * When the operator approves, this verb reads the QA report that qa-engineer
 * left on issue <n> and promotes it into a real goal (manifest entry +
 * one fix-ticket per finding + backend goal instance state).
 *
 * Script-only: sets `ctx.skipAgent` so no LLM runs — it's pure orchestration
 * over the already-produced report. Reuses `promoteReportToGoal`.
 */
import type { PreflightScript } from "../implementations/types.js"
import { getIssue } from "../issue.js"
import { promoteReportToGoal } from "./createQaGoal.js"

const REPORT_JSON_OPEN = "<!-- KODY_QA_REPORT_JSON"

export const promoteQaGoal: PreflightScript = async (ctx) => {
  ctx.skipAgent = true

  const issueNum = ctx.args.issue as number | undefined
  if (typeof issueNum !== "number" || issueNum <= 0) {
    ctx.output.exitCode = 2
    ctx.output.reason = "qa-goal requires --issue <n>"
    process.stderr.write("[qa-goal] missing --issue\n")
    return
  }

  let report: string
  try {
    const issue = getIssue(issueNum, ctx.cwd)
    // Most recent comment carrying the structured QA report wins.
    const reportComment = [...issue.comments].reverse().find((c) => c.body.includes(REPORT_JSON_OPEN))
    if (!reportComment) {
      ctx.output.exitCode = 3
      ctx.output.reason = `no QA report (${REPORT_JSON_OPEN} …) found on issue #${issueNum}`
      process.stderr.write(`[qa-goal] ${ctx.output.reason}\n`)
      return
    }
    report = reportComment.body
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.output.exitCode = 3
    ctx.output.reason = `failed to read issue #${issueNum}: ${msg}`
    process.stderr.write(`[qa-goal] ${ctx.output.reason}\n`)
    return
  }

  await promoteReportToGoal(ctx, report, ctx.args.scope as string | undefined, ctx.args.goal as string | undefined)
}
