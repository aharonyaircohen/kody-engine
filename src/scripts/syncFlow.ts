/**
 * Preflight: merges `origin/<base>` into the PR branch and pushes.
 *
 * Cross-cutting — used by `sync`, `fix`, and `fix-ci`. Composable: success
 * paths leave the run intact so downstream preflights/agent can proceed.
 * Conflict / error paths bail the run by setting `ctx.skipAgent`,
 * `ctx.output.exitCode = 1`, and posting a "kody sync" PR comment that
 * tells the user how to recover (e.g. run `@kody resolve` on conflicts).
 *
 * Args (from profile entry's `with` object):
 *   - announceOnSuccess (default false): when true, success paths post the
 *     user-facing "✅ kody sync ..." / "ℹ️ kody sync ..." PR comment and set
 *     `output.exitCode = 0` + `output.reason`. Set this in the `sync`
 *     executable's profile, where syncFlow IS the run. Leave unset (false)
 *     when used as a preflight in another executable — the parent owns the
 *     user voice on success.
 *
 * Failure paths always announce — the user needs to know why their run
 * stopped, regardless of which executable triggered it.
 *
 * Sets `ctx.data.syncResult` to "noop" | "merged" on success for downstream
 * visibility. Failure paths leave `syncResult` unset and bail the run.
 */

import { execFileSync } from "node:child_process"
import type { PreflightScript, ScriptArgs } from "../executables/types.js"
import { checkoutPrBranch, getCurrentBranch, mergeBase } from "../branch.js"
import { getRunUrl } from "../gha.js"
import { getPr, postPrReviewComment } from "../issue.js"
import { type KodyLabelSpec, setKodyLabel } from "../lifecycleLabels.js"
import { pushWithRetry } from "../pushWithRetry.js"

const DONE: KodyLabelSpec = {
  label: "kody:done",
  color: "0e8a16",
  description: "kody: PR ready for human review/merge",
}

export const syncFlow: PreflightScript = async (ctx, _profile, args?: ScriptArgs) => {
  const announceOnSuccess = Boolean(args?.announceOnSuccess)

  const prNumber = ctx.args.pr as number
  const pr = getPr(prNumber, ctx.cwd)
  if (pr.state !== "OPEN") {
    bail(ctx, prNumber, `PR #${prNumber} is not OPEN (state: ${pr.state})`)
    return
  }
  ctx.data.pr = pr
  if (announceOnSuccess) {
    ctx.data.commentTargetType = "pr"
    ctx.data.commentTargetNumber = prNumber
  }

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
      `merge from origin/${baseBranch} produced conflicts — run \`@kody resolve\` to let kody resolve them`,
    )
    return
  }

  // mergeStatus === "clean"
  const headAfter = revParseHead(ctx.cwd)
  if (headAfter === headBefore) {
    ctx.data.syncResult = "noop"
    if (announceOnSuccess) {
      ctx.output.exitCode = 0
      ctx.output.reason = `already up to date with origin/${baseBranch}`
      // No PR comment on a clean no-op: each issue_comment re-triggers the
      // kody workflow, so commenting on every open PR every sync tick is a
      // 35x-per-tick amplifier. Only failures/conflicts (bail) comment.
      restoreDone(prNumber, ctx.cwd)
    }
    return
  }

  try {
    pushBranch(ctx.data.branch as string, ctx.cwd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    bail(ctx, prNumber, `merge succeeded but push failed: ${msg}`)
    return
  }

  ctx.data.syncResult = "merged"
  if (announceOnSuccess) {
    ctx.output.exitCode = 0
    ctx.output.reason = `merged origin/${baseBranch} into ${ctx.data.branch}`
    // No PR comment on a successful merge: the comment is an issue_comment
    // event that re-dispatches the kody workflow. Posting it on every open
    // PR every sync tick is the runaway-Actions leak. The merge result is
    // still in ctx.output.reason (runner log); only failures/conflicts
    // (bail) post a human-actionable comment.
    restoreDone(prNumber, ctx.cwd)
  }
}

/**
 * Re-stamp kody:done on the PR. The sync executable's preflight stamps
 * kody:syncing (which evicts kody:done via the lifecycle mutex), and the
 * executor's finally-clear removes kody:syncing on exit — without this, a
 * synced PR ends up unlabeled and falls out of the dashboard's "done"
 * column. Only called when syncFlow IS the run (announceOnSuccess); as a
 * preflight in fix/fix-ci the parent owns the terminal label.
 *
 * Best-effort: never fail a sync over a label write.
 */
function restoreDone(prNumber: number, cwd?: string): void {
  try {
    setKodyLabel(prNumber, DONE, cwd)
  } catch {
    /* best effort */
  }
}

function bail(ctx: Parameters<PreflightScript>[0], prNumber: number, reason: string): void {
  ctx.skipAgent = true
  ctx.output.exitCode = 1
  ctx.output.reason = reason
  const runUrl = getRunUrl()
  const runSuffix = runUrl ? ` ([logs](${runUrl}))` : ""
  tryPostPr(prNumber, `❌ kody sync could not complete${runSuffix}: ${reason}`, ctx.cwd)
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
  // Fetch+rebase retry on non-fast-forward. Replaces the old plain →
  // force-with-lease fallback, which could silently overwrite a concurrent
  // push when the remote moved between fetch and push.
  const result = pushWithRetry({ cwd: cwd ?? process.cwd(), branch, setUpstream: true })
  if (!result.ok) {
    throw new Error(result.reason)
  }
}

function tryPostPr(prNumber: number, body: string, cwd?: string): void {
  try {
    postPrReviewComment(prNumber, body, cwd)
  } catch {
    /* best effort */
  }
}
