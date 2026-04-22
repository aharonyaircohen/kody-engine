/**
 * Flow script for the `sync` executable.
 *
 * Merges `origin/<base>` into the PR branch and pushes. If the merge produces
 * conflicts, bails and tells the user to run `@kody2 resolve`. Never invokes
 * the agent — this is a pure git operation.
 */

import { execFileSync } from "node:child_process"
import { checkoutPrBranch, getCurrentBranch, mergeBase } from "../branch.js"
import type { PreflightScript } from "../executables/types.js"
import { getRunUrl } from "../gha.js"
import { getPr, postPrReviewComment } from "../issue.js"

export const syncFlow: PreflightScript = async (ctx) => {
  ctx.skipAgent = true

  const prNumber = ctx.args.pr as number
  const pr = getPr(prNumber, ctx.cwd)
  if (pr.state !== "OPEN") {
    bail(ctx, prNumber, `PR #${prNumber} is not OPEN (state: ${pr.state})`)
    return
  }
  ctx.data.pr = pr
  ctx.data.commentTargetType = "pr"
  ctx.data.commentTargetNumber = prNumber

  checkoutPrBranch(prNumber, ctx.cwd)
  ctx.data.branch = getCurrentBranch(ctx.cwd)

  const baseBranch = pr.baseRefName || ctx.config.git.defaultBranch
  ctx.data.baseBranch = baseBranch

  const headBefore = revParseHead(ctx.cwd)
  const mergeStatus = mergeBase(baseBranch, ctx.cwd)

  if (mergeStatus === "error") {
    bail(ctx, prNumber, `failed to merge origin/${baseBranch} (non-conflict error); see runner log`)
    return
  }

  if (mergeStatus === "conflict") {
    bail(
      ctx,
      prNumber,
      `merge from origin/${baseBranch} produced conflicts — run \`@kody2 resolve\` to let kody2 resolve them`,
    )
    return
  }

  // mergeStatus === "clean"
  const headAfter = revParseHead(ctx.cwd)
  if (headAfter === headBefore) {
    ctx.output.exitCode = 0
    ctx.output.reason = `already up to date with origin/${baseBranch}`
    tryPostPr(prNumber, `ℹ️ kody2 sync: already up to date with origin/${baseBranch}`, ctx.cwd)
    return
  }

  try {
    pushBranch(ctx.data.branch as string, ctx.cwd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    bail(ctx, prNumber, `merge succeeded but push failed: ${msg}`)
    return
  }

  ctx.output.exitCode = 0
  ctx.output.reason = `merged origin/${baseBranch} into ${ctx.data.branch}`
  const runUrl = getRunUrl()
  const runSuffix = runUrl ? ` ([logs](${runUrl}))` : ""
  tryPostPr(prNumber, `✅ kody2 sync: merged \`origin/${baseBranch}\` into \`${ctx.data.branch}\`${runSuffix}`, ctx.cwd)
}

function bail(ctx: Parameters<PreflightScript>[0], prNumber: number, reason: string): void {
  ctx.output.exitCode = 1
  ctx.output.reason = reason
  const runUrl = getRunUrl()
  const runSuffix = runUrl ? ` ([logs](${runUrl}))` : ""
  tryPostPr(prNumber, `❌ kody2 sync could not complete${runSuffix}: ${reason}`, ctx.cwd)
}

function revParseHead(cwd?: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim()
  } catch {
    return ""
  }
}

function pushBranch(branch: string, cwd?: string): void {
  const env = { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" }
  try {
    execFileSync("git", ["push", "-u", "origin", branch], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
  } catch {
    execFileSync("git", ["push", "--force-with-lease", "-u", "origin", branch], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
  }
}

function tryPostPr(prNumber: number, body: string, cwd?: string): void {
  try {
    postPrReviewComment(prNumber, body, cwd)
  } catch {
    /* best effort */
  }
}
