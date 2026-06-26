/**
 * Flow script for the `resolve` executable.
 *
 * GitHub's `mergeable` field is the authoritative source of truth for
 * "is there a conflict?" We consult it FIRST. The local `git merge` is
 * an action (collecting conflict markers), not a status check —
 * separating the two avoids the bug we hit on A-Guy #1525 where the
 * local merge said "Already up to date" but GitHub still reported
 * CONFLICTING (its mergeable cache was stale relative to a prior sync).
 *
 * Decision table:
 *   - GitHub `MERGEABLE`     → nothing to resolve; courtesy comment + exit.
 *   - GitHub `BLOCKED`       → mergeable in principle but gated by checks/
 *                              reviews; resolve has no work; comment + exit.
 *   - GitHub `CONFLICTING`   → run local `git merge`; if it produces
 *                              conflicts, hand to the agent; if it's
 *                              clean (stale cache), push an empty commit
 *                              to force GitHub to re-evaluate.
 *   - GitHub `UNKNOWN`/`ERROR` → fall through to local merge; treat as
 *                              best-effort (preserves prior behavior).
 */

import { execFileSync } from "node:child_process"
import type { PreflightScript } from "../executables/types.js"
import { checkoutPrBranch, getCurrentBranch, mergeBase } from "../branch.js"
import { getRunUrl } from "../gha.js"
import { getPr, postPrReviewComment } from "../issue.js"
import { prMergeStatus } from "../pr.js"

const CONFLICT_DIFF_MAX_BYTES = 40_000

export const resolveFlow: PreflightScript = async (ctx) => {
  const prNumber = ctx.args.pr as number
  const pr = getPr(prNumber, ctx.cwd)
  if (pr.state !== "OPEN") {
    ctx.output.exitCode = 1
    ctx.output.reason = `PR #${prNumber} is not OPEN (state: ${pr.state})`
    ctx.skipAgent = true
    return
  }
  ctx.data.pr = pr
  ctx.data.commentTargetType = "pr"
  ctx.data.commentTargetNumber = prNumber

  const baseBranch = pr.baseRefName || ctx.config.git.defaultBranch
  ctx.data.baseBranch = baseBranch

  // Ask GitHub first — single source of truth for "is there a conflict?"
  const ghStatus = prMergeStatus(prNumber, ctx.cwd)

  if (ghStatus.status === "MERGEABLE") {
    ctx.output.exitCode = 0
    ctx.output.reason = `PR #${prNumber} is mergeable (no conflicts) — nothing to resolve`
    ctx.skipAgent = true
    tryPostPr(prNumber, `ℹ️ kody resolve: ${ctx.output.reason}`, ctx.cwd)
    return
  }
  if (ghStatus.status === "BLOCKED") {
    ctx.output.exitCode = 0
    ctx.output.reason = `PR #${prNumber} is mergeable but blocked by checks/reviews (mergeStateStatus=${ghStatus.mergeStateStatus}) — nothing for resolve to do`
    ctx.skipAgent = true
    tryPostPr(prNumber, `ℹ️ kody resolve: ${ctx.output.reason}`, ctx.cwd)
    return
  }

  // CONFLICTING / UNKNOWN / ERROR — proceed with local merge.
  checkoutPrBranch(prNumber, ctx.cwd)
  ctx.data.branch = getCurrentBranch(ctx.cwd)

  const mergeStatus = mergeBase(baseBranch, ctx.cwd)
  if (mergeStatus === "clean") {
    // GitHub said CONFLICTING but local merge is clean — likely a stale
    // mergeable cache on GitHub's side. Push an empty commit to force
    // GitHub to re-evaluate; next auto-resolve tick will see MERGEABLE
    // and skip. Best-effort — failure is non-fatal.
    if (ghStatus.status === "CONFLICTING") {
      const pushed = pushEmptyCommit(ctx.data.branch as string, ctx.cwd)
      ctx.output.exitCode = 0
      ctx.output.reason = pushed
        ? `local merge clean despite GitHub reporting CONFLICTING — pushed empty commit to force re-evaluation`
        : `local merge clean despite GitHub reporting CONFLICTING — couldn't refresh GitHub cache (push failed)`
      ctx.skipAgent = true
      tryPostPr(prNumber, `ℹ️ kody resolve: ${ctx.output.reason}`, ctx.cwd)
      return
    }
    ctx.output.exitCode = 0
    ctx.output.reason = `already up to date with origin/${baseBranch} — nothing to resolve`
    ctx.skipAgent = true
    tryPostPr(prNumber, `ℹ️ kody resolve: ${ctx.output.reason}`, ctx.cwd)
    return
  }
  if (mergeStatus === "error") {
    ctx.output.exitCode = 99
    ctx.output.reason = `failed to merge origin/${baseBranch} (non-conflict error); see runner log`
    ctx.skipAgent = true
    tryPostPr(prNumber, `⚠️ kody resolve FAILED: ${ctx.output.reason}`, ctx.cwd)
    return
  }

  const conflictedFiles = getConflictedFiles(ctx.cwd)
  if (conflictedFiles.length === 0) {
    ctx.output.exitCode = 99
    ctx.output.reason = "merge reported conflict but no unmerged paths detected"
    ctx.skipAgent = true
    return
  }

  ctx.data.conflictedFiles = conflictedFiles
  ctx.data.conflictMarkersPreview = getConflictMarkersPreview(conflictedFiles, ctx.cwd)
  ctx.data.preferBlock = buildPreferBlock(ctx.args.prefer as string | undefined, baseBranch)
  const runUrl = getRunUrl()
  const runSuffix = runUrl ? `, run ${runUrl}` : ""
  tryPostPr(
    prNumber,
    `⚙️ kody resolve started on \`${ctx.data.branch}\`${runSuffix} — ${conflictedFiles.length} conflicted file(s)`,
    ctx.cwd,
  )
}

function buildPreferBlock(prefer: string | undefined, baseBranch: string): string {
  if (prefer !== "ours" && prefer !== "theirs") return ""
  const keepSide = prefer === "ours" ? "HEAD (this PR branch)" : `origin/${baseBranch} (base branch)`
  const keepMarkers =
    prefer === "ours"
      ? "content between `<<<<<<< HEAD` and `=======`"
      : `content between \`=======\` and \`>>>>>>> origin/${baseBranch}\``
  const dropSide = prefer === "ours" ? `origin/${baseBranch}` : "HEAD"
  return [
    "# Conflict resolution directive (AUTHORITATIVE — overrides defaults below)",
    "",
    `The user requested \`--prefer ${prefer}\`. For **every** conflict in **every** file:`,
    "",
    `- Keep the **${prefer}** side: ${keepSide} — ${keepMarkers}.`,
    `- Discard the **${prefer === "ours" ? "theirs" : "ours"}** side (from ${dropSide}) entirely.`,
    "- Remove all `<<<<<<<`, `=======`, `>>>>>>>` markers.",
    "- Do NOT attempt to merge the two sides or apply judgement.",
    "",
  ].join("\n")
}

function getConflictedFiles(cwd?: string): string[] {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
      encoding: "utf-8",
      cwd,
      env: { ...process.env, HUSKY: "0" },
    }).trim()
    return out ? out.split("\n").filter(Boolean) : []
  } catch {
    return []
  }
}

function getConflictMarkersPreview(files: string[], cwd?: string, maxBytes = CONFLICT_DIFF_MAX_BYTES): string {
  const chunks: string[] = []
  let total = 0
  for (const f of files) {
    try {
      const content = execFileSync("cat", [f], { encoding: "utf-8", cwd }).toString()
      const snippet = `### ${f}\n\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\`\n`
      total += snippet.length
      chunks.push(snippet)
      if (total >= maxBytes) break
    } catch {
      /* skip */
    }
  }
  return chunks.join("\n")
}

function tryPostPr(prNumber: number, body: string, cwd?: string): void {
  try {
    postPrReviewComment(prNumber, body, cwd)
  } catch {
    /* best effort */
  }
}

/**
 * Push an empty commit on the PR branch to force GitHub to recompute
 * its `mergeable` status. Used when GitHub's cached status disagrees
 * with the local merge result. Best-effort; returns whether the push
 * succeeded so the caller can phrase its log message correctly.
 */
function pushEmptyCommit(branch: string, cwd?: string): boolean {
  const env = { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" }
  try {
    execFileSync(
      "git",
      ["commit", "--allow-empty", "-m", "chore: kody resolve refresh — empty commit to recompute mergeable status"],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    )
    execFileSync("git", ["push", "-u", "origin", branch], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return true
  } catch {
    return false
  }
}
