/**
 * Preflight: list open issues tagged with a given label, then invoke a target
 * executable once per matching issue (in-process, sequentially). Each child
 * run is isolated — failures on one issue don't stop later issues.
 *
 * This is the fan-out primitive for mission-style scheduled executables:
 * one cron wake → N classifier ticks, one per live mission issue.
 *
 * Script args (via `with:`):
 *   label             required — e.g. "kody:mission"
 *   targetExecutable  required — e.g. "mission-tick"
 *   issueArg          optional — CLI input name the target expects (default "issue")
 *
 * Sets ctx.skipAgent so the outer scheduler itself never invokes the SDK.
 */

import type { PreflightScript } from "../executables/types.js"
import { runExecutable } from "../executor.js"
import { gh } from "../issue.js"

interface IssueRef {
  number: number
  title: string
}

export const dispatchMissionTicks: PreflightScript = async (ctx, _profile, args) => {
  ctx.skipAgent = true

  const label = String(args?.label ?? "")
  const targetExecutable = String(args?.targetExecutable ?? "")
  if (!label) throw new Error("dispatchMissionTicks: `with.label` is required")
  if (!targetExecutable) throw new Error("dispatchMissionTicks: `with.targetExecutable` is required")
  const issueArg = String(args?.issueArg ?? "issue")

  const issues = listIssuesByLabel(label, ctx.cwd)
  ctx.data.missionIssueCount = issues.length

  if (issues.length === 0) {
    process.stdout.write(`[missions] no open issues with label "${label}"\n`)
    return
  }

  process.stdout.write(`[missions] ticking ${issues.length} issue(s) via ${targetExecutable}\n`)

  const results: Array<{ issue: number; exitCode: number; reason?: string }> = []
  for (const issue of issues) {
    process.stdout.write(`[missions] → tick #${issue.number}: ${issue.title}\n`)
    try {
      const out = await runExecutable(targetExecutable, {
        cliArgs: { [issueArg]: issue.number },
        cwd: ctx.cwd,
        config: ctx.config,
        verbose: ctx.verbose,
        quiet: ctx.quiet,
      })
      results.push({ issue: issue.number, exitCode: out.exitCode, reason: out.reason })
      if (out.exitCode !== 0) {
        process.stderr.write(`[missions] tick #${issue.number} failed (exit ${out.exitCode}): ${out.reason ?? ""}\n`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[missions] tick #${issue.number} crashed: ${msg}\n`)
      results.push({ issue: issue.number, exitCode: 99, reason: msg })
    }
  }

  ctx.data.missionTickResults = results
  // Scheduler itself always exits 0 — individual tick failures are reported
  // per-issue in stderr but don't fail the cron job. Humans will see errors
  // on the mission issues themselves via the state comment.
  ctx.output.exitCode = 0
}

function listIssuesByLabel(label: string, cwd: string): IssueRef[] {
  let raw = ""
  try {
    raw = gh(
      ["issue", "list", "--state", "open", "--label", label, "--limit", "100", "--json", "number,title"],
      { cwd },
    )
  } catch {
    return []
  }
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  return (list as Array<Record<string, unknown>>)
    .filter((x) => typeof x.number === "number" && typeof x.title === "string")
    .map((x) => ({ number: x.number as number, title: x.title as string }))
}
