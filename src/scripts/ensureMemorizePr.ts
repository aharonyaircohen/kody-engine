/**
 * Postflight for `memorize`: open or update a PR with the vault changes.
 *
 * Differs from ensurePr in that it:
 *   - has no source issue ("Closes #N" makes no sense for memorize),
 *   - sets a fixed title shape ("kody memorize: vault update YYYY-MM-DD"),
 *   - bails silently when the agent produced no commits (typical "nothing
 *     new to memorize" tick),
 *   - never marks the PR as draft — vault edits don't have a verify step.
 */

import type { PostflightScript } from "../executables/types.js"
import { gh } from "../issue.js"
import { findExistingPr } from "../pr.js"

const TITLE_MAX = 72

export const ensureMemorizePr: PostflightScript = async (ctx) => {
  if (ctx.skipAgent && ctx.output.exitCode !== undefined && ctx.output.exitCode !== 0) {
    return
  }

  const commitResult = ctx.data.commitResult as { committed: boolean; pushed?: boolean } | undefined
  const hasCommits = Boolean(ctx.data.hasCommitsAhead)
  if (!commitResult?.committed && !hasCommits) {
    process.stdout.write("[kody memorize] no vault changes — skipping PR\n")
    ctx.output.exitCode = 0
    ctx.output.reason = "no vault changes"
    return
  }

  // hasCommitsAhead compares the local branch against origin/<default>; a local
  // commit can show as ahead even when the branch was never pushed (auth error,
  // protected-branch rule, etc.). gh pr create needs the branch on origin —
  // refuse to call it if commitAndPush couldn't push.
  if (commitResult?.committed && commitResult.pushed === false) {
    const reason = (ctx.data.commitCrash as string | undefined) ?? "push failed"
    ctx.output.exitCode = 4
    ctx.output.reason = `memorize: branch not pushed to origin — ${reason}`
    process.stderr.write(`[kody memorize] not opening PR: ${ctx.output.reason}\n`)
    return
  }

  const branch = ctx.data.branch as string | undefined
  if (!branch) {
    ctx.output.exitCode = 4
    ctx.output.reason = "memorize: no branch on ctx.data.branch"
    return
  }

  const datestamp = new Date().toISOString().slice(0, 10)
  const titleBase = `kody memorize: vault update ${datestamp}`
  const title = titleBase.length <= TITLE_MAX ? titleBase : `${titleBase.slice(0, TITLE_MAX - 1)}…`
  const body = buildBody(ctx, branch, datestamp)

  const existing = findExistingPr(branch, ctx.cwd)
  if (existing) {
    try {
      gh(["pr", "edit", String(existing.number), "--body-file", "-"], { input: body, cwd: ctx.cwd })
      ctx.output.prUrl = existing.url
      ctx.data.prResult = { url: existing.url, number: existing.number, action: "updated" }
      process.stdout.write(`[kody memorize] updated PR ${existing.url}\n`)
    } catch (err) {
      ctx.output.exitCode = 4
      ctx.output.reason = `gh pr edit #${existing.number} failed: ${err instanceof Error ? err.message : String(err)}`
    }
    return
  }

  try {
    const output = gh(
      ["pr", "create", "--head", branch, "--base", ctx.config.git.defaultBranch, "--title", title, "--body-file", "-"],
      { input: body, cwd: ctx.cwd },
    )
    const url = output.trim()
    const match = url.match(/\/pull\/(\d+)$/)
    const number = match ? parseInt(match[1]!, 10) : 0
    ctx.output.prUrl = url
    ctx.data.prResult = { url, number, action: "created" }
    process.stdout.write(`[kody memorize] opened PR ${url}\n`)
  } catch (err) {
    ctx.output.exitCode = 4
    ctx.output.reason = `PR creation failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

function buildBody(ctx: Parameters<PostflightScript>[0], branch: string, datestamp: string): string {
  const lines: string[] = []
  lines.push("## Summary")
  lines.push("")
  const summary = (ctx.data.prSummary as string | undefined)?.trim()
  if (summary) {
    lines.push(summary)
  } else {
    lines.push(`Vault knowledge base update for ${datestamp}.`)
  }
  lines.push("")
  const changedFiles = (ctx.data.changedFiles as string[] | undefined) ?? []
  if (changedFiles.length > 0) {
    lines.push("## Changes")
    lines.push("")
    for (const f of changedFiles.slice(0, 50)) lines.push(`- \`${f}\``)
    if (changedFiles.length > 50) lines.push(`- … and ${changedFiles.length - 50} more`)
    lines.push("")
  }
  const recentCount = ctx.data.recentPrCount as number | undefined
  if (typeof recentCount === "number") {
    lines.push(`Synthesized from ${recentCount} merged PR(s) since ${ctx.data.vaultSinceIso ?? "(unknown)"}.`)
    lines.push("")
  }
  lines.push("---")
  lines.push(`_Opened by kody memorize on branch \`${branch}\`._`)
  return lines.join("\n")
}
