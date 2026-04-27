/**
 * watchStalePrsFlow — preflight for a scheduled kody executable.
 * Lists open PRs not touched in N days, posts a digest comment to a
 * designated issue (or stdout-only if none configured).
 *
 * Agent-free: sets ctx.skipAgent. Entirely wrapper logic.
 *
 * Config:
 *   kody.config.json#watch.staleDays            number, default 7
 *   kody.config.json#watch.reportIssueNumber    number, optional
 */

import type { PreflightScript } from "../executables/types.js"
import { gh, postIssueComment, truncate } from "../issue.js"

interface WatchConfig {
  staleDays?: number
  reportIssueNumber?: number
}

function readWatchConfig(ctx: Parameters<PreflightScript>[0]): WatchConfig {
  const cfg = (ctx.config as unknown as Record<string, unknown>).watch
  if (!cfg || typeof cfg !== "object") return {}
  const r = cfg as Record<string, unknown>
  return {
    staleDays: typeof r.staleDays === "number" && r.staleDays > 0 ? Math.floor(r.staleDays) : undefined,
    reportIssueNumber:
      typeof r.reportIssueNumber === "number" && r.reportIssueNumber > 0 ? Math.floor(r.reportIssueNumber) : undefined,
  }
}

interface StalePr {
  number: number
  title: string
  url: string
  updatedAt: string
  daysStale: number
}

export function findStalePrs(cwd: string, staleDays: number, now: Date = new Date()): StalePr[] {
  let raw = ""
  try {
    raw = gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,url,updatedAt"], { cwd })
  } catch {
    return []
  }
  let list: Array<{ number: number; title: string; url: string; updatedAt: string }>
  try {
    list = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []

  const cutoffMs = now.getTime() - staleDays * 24 * 60 * 60 * 1000
  const stale: StalePr[] = []
  for (const pr of list) {
    const ts = Date.parse(pr.updatedAt)
    if (!Number.isFinite(ts) || ts > cutoffMs) continue
    const daysStale = Math.floor((now.getTime() - ts) / (24 * 60 * 60 * 1000))
    stale.push({ number: pr.number, title: pr.title, url: pr.url, updatedAt: pr.updatedAt, daysStale })
  }
  return stale.sort((a, b) => b.daysStale - a.daysStale)
}

export function formatStaleReport(stale: StalePr[], staleDays: number): string {
  if (stale.length === 0) {
    return `🟢 **kody watch-stale-prs** — no open PRs untouched for more than ${staleDays} days. ✨`
  }
  const lines: string[] = [`🟡 **kody watch-stale-prs** — ${stale.length} PR(s) untouched for > ${staleDays} days:`, ""]
  for (const pr of stale.slice(0, 50)) {
    lines.push(`- [#${pr.number}](${pr.url}) — *${truncate(pr.title, 80)}* (${pr.daysStale} days stale)`)
  }
  if (stale.length > 50) lines.push(`- … and ${stale.length - 50} more`)
  return lines.join("\n")
}

export const watchStalePrsFlow: PreflightScript = async (ctx) => {
  ctx.skipAgent = true
  const { staleDays = 7, reportIssueNumber } = readWatchConfig(ctx)

  const stale = findStalePrs(ctx.cwd, staleDays)
  const report = formatStaleReport(stale, staleDays)

  process.stdout.write(`${report}\n`)

  if (reportIssueNumber) {
    try {
      postIssueComment(reportIssueNumber, report, ctx.cwd)
    } catch (err) {
      process.stderr.write(
        `[kody watch] failed to post to issue #${reportIssueNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  ctx.output.exitCode = 0
  ctx.data.staleCount = stale.length
}
