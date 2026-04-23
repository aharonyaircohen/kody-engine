/**
 * Postflight: write a run-summary artifact to GITHUB_STEP_SUMMARY when running
 * in GitHub Actions. Gives consumers a one-glance view of what happened
 * (mode, target, PR URL, exit code, failure reason) without log-scraping.
 */

import * as fs from "node:fs"
import type { PostflightScript } from "../executables/types.js"

export const writeRunSummary: PostflightScript = async (ctx, profile) => {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return

  const executable = profile.name
  const issue = ctx.args.issue as number | undefined
  const pr = ctx.args.pr as number | undefined
  const target = issue ? `issue #${issue}` : pr ? `PR #${pr}` : "(unknown)"
  const prUrl = ctx.output.prUrl
  const exitCode = ctx.output.exitCode ?? 0
  const reason = ctx.output.reason
  const status = exitCode === 0 ? "✅ success" : exitCode === 3 ? "⏭️ no-op" : "⚠️ failed"

  const lines: string[] = []
  lines.push(`## kody ${executable} — ${status}`)
  lines.push("")
  lines.push(`- **Executable:** \`${executable}\``)
  lines.push(`- **Target:** ${target}`)
  if (prUrl) lines.push(`- **PR:** ${prUrl}`)
  lines.push(`- **Exit code:** ${exitCode}`)
  if (reason) lines.push(`- **Reason:** ${reason}`)
  lines.push("")

  try {
    fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`)
  } catch {
    /* best effort */
  }
}
