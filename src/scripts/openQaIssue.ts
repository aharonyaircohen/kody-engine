/**
 * Postflight for the `qa-engineer` executable. Takes the agent's final message
 * (the entire QA report) and posts it as either:
 *   - a comment on an existing issue (when --issue <N> is set)
 *   - a brand-new issue (default), labeled `kody:qa-report`
 *
 * The agent never runs `gh` itself (block-git hook), so this script is the
 * only path that writes to GitHub.
 *
 * Exit codes:
 *   PASS / CONCERNS  → 0
 *   FAIL             → 1
 *   missing report / agent crashed / post failed → 1+ (failure path)
 */
import type { AgentResult } from "../agent.js"
import type { PostflightScript } from "../executables/types.js"
import { gh, postIssueComment, truncate } from "../issue.js"
import type { Action } from "../state.js"
import { detectVerdict, type ReviewVerdict } from "./postReviewResult.js"

const QA_LABEL = "kody:qa-report"

function qaAction(verdict: ReviewVerdict, payload: Record<string, unknown>): Action {
  const type =
    verdict === "PASS"
      ? "QA_PASS"
      : verdict === "CONCERNS"
        ? "QA_CONCERNS"
        : verdict === "FAIL"
          ? "QA_FAIL"
          : "QA_COMPLETED"
  return { type, payload: { verdict, ...payload }, timestamp: new Date().toISOString() }
}

function failedAction(reason: string): Action {
  return { type: "QA_FAILED", payload: { reason }, timestamp: new Date().toISOString() }
}

function slugifyScope(scope: string): string {
  return scope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
}

function buildIssueTitle(scope: string | undefined, verdict: ReviewVerdict): string {
  const date = new Date().toISOString().slice(0, 10)
  const focus = scope?.trim() ? scope.trim() : "smoke"
  const verdictTag = verdict === "UNKNOWN" ? "REPORT" : verdict
  return `QA [${verdictTag}]: ${focus} — ${date}`.slice(0, 240)
}

function ensureLabel(cwd: string): boolean {
  // gh label create is idempotent with --force; fall back silently if the
  // user lacks repo-admin scope (label-add is best-effort, not required for
  // the issue itself to land).
  try {
    gh(["label", "create", QA_LABEL, "--color", "8b5cf6", "--description", "kody: QA report", "--force"], { cwd })
    return true
  } catch {
    return false
  }
}

function createQaIssue(title: string, body: string, hasLabel: boolean, cwd: string): { number: number; url: string } {
  const args = ["issue", "create", "--title", title, "--body-file", "-"]
  if (hasLabel) args.push("--label", QA_LABEL)
  // gh issue create returns the new issue URL on its last stdout line.
  const out = gh(args, { input: body, cwd })
  const url =
    out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ""
  const m = url.match(/\/issues\/(\d+)\b/)
  if (!m) throw new Error(`gh issue create returned unexpected output: ${out}`)
  return { number: Number(m[1]), url }
}

export const openQaIssue: PostflightScript = async (ctx, _profile, agentResult: AgentResult | null) => {
  if (!agentResult || agentResult.outcome !== "completed") {
    const reason = agentResult?.error ?? "agent did not complete"
    process.stderr.write(`qa-engineer: ${reason}\n`)
    ctx.output.exitCode = 1
    ctx.output.reason = reason
    ctx.data.action = failedAction(reason)
    return
  }

  const reportBody = agentResult.finalText.trim()
  if (!reportBody) {
    process.stderr.write("qa-engineer: agent produced no report body\n")
    ctx.output.exitCode = 1
    ctx.output.reason = "empty report body"
    ctx.data.action = failedAction("empty report body")
    return
  }

  const verdict = detectVerdict(reportBody)
  ctx.data.qaVerdict = verdict
  ctx.data.qaReport = reportBody

  const existingIssue = ctx.args.issue as number | undefined

  if (typeof existingIssue === "number" && Number.isFinite(existingIssue) && existingIssue > 0) {
    try {
      postIssueComment(existingIssue, reportBody, ctx.cwd)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.output.exitCode = 4
      ctx.output.reason = `failed to comment on issue #${existingIssue}: ${msg}`
      ctx.data.action = failedAction(ctx.output.reason)
      return
    }
    process.stdout.write(
      `\nQA_REPORT_POSTED=https://github.com/${ctx.config.github.owner}/${ctx.config.github.repo}/issues/${existingIssue} (verdict: ${verdict})\n`,
    )
    ctx.data.action = qaAction(verdict, { issueNumber: existingIssue, mode: "comment" })
    ctx.output.exitCode = verdict === "FAIL" ? 1 : 0
    return
  }

  // Default: open a new issue.
  const scope = ctx.args.scope as string | undefined
  const title = buildIssueTitle(scope, verdict)
  const hasLabel = ensureLabel(ctx.cwd)

  let created: { number: number; url: string }
  try {
    created = createQaIssue(title, reportBody, hasLabel, ctx.cwd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.output.exitCode = 4
    ctx.output.reason = `failed to open QA issue: ${truncate(msg, 1000)}`
    ctx.data.action = failedAction(ctx.output.reason)
    return
  }

  process.stdout.write(`\nQA_REPORT_POSTED=${created.url} (verdict: ${verdict})\n`)
  ctx.data.action = qaAction(verdict, {
    issueNumber: created.number,
    issueUrl: created.url,
    titleSlug: scope ? slugifyScope(scope) : "smoke",
    mode: "create",
  })
  ctx.output.exitCode = verdict === "FAIL" ? 1 : 0
}
