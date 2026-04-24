/**
 * Postflight: open or update the PR. Draft on any failure, normal on full success.
 * No-op if commitAndPush didn't produce any change and the branch isn't ahead.
 */

import type { PostflightScript } from "../executables/types.js"
import { ensurePr as doEnsurePr } from "../pr.js"

export const ensurePr: PostflightScript = async (ctx) => {
  if (ctx.skipAgent && ctx.output.exitCode !== undefined) {
    // Preflight was authoritative — either it refused to start (exit != 0)
    // or it did the work itself and short-circuited (exit === 0, e.g. a
    // shell entry that emitted KODY_SKIP_AGENT=true, or resolveFlow's
    // clean-merge path). In both cases ensurePr has nothing useful to do.
    // Previously this check only bailed on failure, so short-circuit
    // success paths tripped the "agent did not emit DONE" branch and
    // tried to draftify an existing PR.
    return
  }

  const commitResult = ctx.data.commitResult as { committed: boolean } | undefined
  const hasCommits = Boolean(ctx.data.hasCommitsAhead)
  if (!commitResult?.committed && !hasCommits) {
    // Nothing to ship. Let postIssueComment surface the "no changes" state.
    return
  }

  const branch = ctx.data.branch as string | undefined
  if (!branch) return

  const failureReason = computeFailureReason(ctx)
  const isFailure = failureReason.length > 0
  const changedFiles = (ctx.data.changedFiles as string[] | undefined) ?? []

  const issue = ctx.data.issue as { title?: string } | undefined
  const pr = ctx.data.pr as { title?: string } | undefined
  const targetNumber = Number(ctx.data.commentTargetNumber ?? 0)
  const title = issue?.title ?? pr?.title ?? `kody changes`

  try {
    const result = doEnsurePr({
      branch,
      defaultBranch: ctx.config.git.defaultBranch,
      issueNumber: targetNumber,
      issueTitle: title,
      draft: isFailure,
      failureReason: isFailure ? failureReason : undefined,
      changedFiles,
      agentSummary: ctx.data.prSummary as string | undefined,
      cwd: ctx.cwd,
    })
    ctx.output.prUrl = result.url
    ctx.data.prResult = result
  } catch (err) {
    const reason = `PR creation failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.data.prCrashReason = reason
    ctx.output.exitCode = 4
    ctx.output.reason = reason
  }
}

function computeFailureReason(ctx: { data: Record<string, unknown> }): string {
  const misses = (ctx.data.coverageMisses as { expectedTest: string }[] | undefined) ?? []
  if (misses.length > 0) return `missing tests: ${misses.map((m) => m.expectedTest).join(", ")}`

  const agentDone = Boolean(ctx.data.agentDone)
  if (!agentDone) {
    return (
      (ctx.data.agentFailureReason as string) ||
      (ctx.data.agentError as string) ||
      (ctx.data.commitCrash as string) ||
      "agent did not emit DONE"
    )
  }

  if (ctx.data.verifyOk === false) return (ctx.data.verifyReason as string) || "verify failed"

  return ""
}
