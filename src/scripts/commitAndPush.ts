/**
 * Postflight: commit whatever is staged and push the branch. Records the
 * commit result on ctx.data.commitResult for downstream postflights
 * (ensurePr, postIssueComment) to consume.
 *
 * Staging and pre-commit cleanup are handled by earlier
 * postflight entries (e.g. abortUnfinishedGitOps for normal flows,
 * stageMergeConflicts for merge flows). This script does not branch on
 * implementation identity.
 *
 * Commit message source (in priority order):
 *   1. ctx.data.commitMessage (agent's COMMIT_MSG line, parsed by parseAgentResult)
 *   2. generic fallback ("chore: kody changes")
 */

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  commitAndPush as doCommitAndPush,
  hasCommitsAhead,
  isForbiddenPath,
  listChangedFiles,
  listFilesInCommit,
} from "../commit.js"
import { resolveRunId } from "../events.js"
import type { PostflightScript } from "../implementations/types.js"
import { runtimeStatePath } from "../runtimePaths.js"

const DEFAULT_COMMIT_MESSAGE = "chore: kody changes"

/**
 * Sentinel file written by commitAndPush on its first successful execution.
 * Workflow executions are scoped independently so a later repair step can
 * commit to the same PR, while a retry of the same logical step still replays
 * its recorded result and avoids duplicate commits.
 *
 * Disabled when KODY_COMMIT_IDEMPOTENCY=0.
 */
function sentinelPathForStage(cwd: string, profileName: string, workflowExecutionKey: unknown): string {
  const runId = resolveRunId()
  const executionSuffix =
    typeof workflowExecutionKey === "string" && workflowExecutionKey.length > 0
      ? `-${createHash("sha256").update(workflowExecutionKey).digest("hex").slice(0, 16)}`
      : ""
  return runtimeStatePath(cwd, "agent-runs", runId, `commit-${profileName}${executionSuffix}.lock`)
}

export const commitAndPush: PostflightScript = async (ctx, profile) => {
  const branch = ctx.data.branch as string | undefined
  if (!branch) {
    ctx.data.commitResult = { committed: false, pushed: false }
    return
  }

  // Idempotency sentinel — short-circuit if this commitAndPush has
  // already run successfully for the same (runId, implementation) tuple.
  const idempotencyEnabled = process.env.KODY_COMMIT_IDEMPOTENCY !== "0"
  const sentinel = idempotencyEnabled
    ? sentinelPathForStage(ctx.cwd, profile.name, ctx.data.workflowExecutionKey)
    : null
  if (sentinel && fs.existsSync(sentinel)) {
    try {
      const replay = JSON.parse(fs.readFileSync(sentinel, "utf-8")) as {
        commitResult?: unknown
        changedFiles?: string[]
        hasCommitsAhead?: boolean
        salvagedFromMissingMarker?: boolean
        commitCrash?: string
        exitCode?: number
        reason?: string
      }
      ctx.data.commitResult = replay.commitResult ?? { committed: false, pushed: false }
      if (Array.isArray(replay.changedFiles)) ctx.data.changedFiles = replay.changedFiles
      if (typeof replay.hasCommitsAhead === "boolean") ctx.data.hasCommitsAhead = replay.hasCommitsAhead
      if (replay.salvagedFromMissingMarker) ctx.data.salvagedFromMissingMarker = true
      // A committed-but-unpushed first attempt must replay as the same
      // failure, not as success — otherwise a re-entry reports green while
      // the commits never reached origin.
      if (typeof replay.commitCrash === "string") {
        ctx.data.commitCrash = replay.commitCrash
        if (typeof replay.exitCode === "number" && (ctx.output.exitCode === undefined || ctx.output.exitCode === 0)) {
          ctx.output.exitCode = replay.exitCode
        }
        if (!ctx.output.reason && replay.reason) ctx.output.reason = replay.reason
      }
      ctx.data.commitIdempotencyReplay = true
      process.stderr.write(`[kody commitAndPush] idempotency replay (sentinel ${sentinel})\n`)
      return
    } catch {
      // Sentinel unreadable — fall through and re-attempt. Safer than
      // crashing on a corrupted lock file.
    }
  }

  // If the verify postflight (which runs earlier in the pr-branch chain)
  // found typecheck/lint/test failures, do NOT push the agent's edits. The
  // agent may have self-reported DONE (agentDone=true) but verify is the
  // ratifier — pushing code that verify just rejected pollutes the branch
  // with broken commits that compound across retry attempts. The agent's
  // working-tree changes stay locally for the duration of this process so
  // run logs / artifacts capture what was tried; subsequent retries see a
  // clean branch.
  //
  // Skipped when verify didn't run (lifecycleConfig.verify=false), in which
  // case verifyOk stays undefined and the strict `=== false` check is a no-op.
  if (ctx.data.verifyOk === false) {
    ctx.data.commitResult = { committed: false, pushed: false, skippedReason: "verifyFailed" }
    ctx.data.hasCommitsAhead = hasCommitsAhead(branch, ctx.config.git.defaultBranch, ctx.cwd)
    return
  }

  // If an earlier postflight (e.g. requireFeedbackActions) flipped agentDone
  // to false, we must not commit the agent's edits. Leave them in the working
  // tree so the failure reason is surfaced without polluting the branch.
  //
  // Exception: when agentDone=false ONLY because the agent forgot to emit the
  // DONE/COMMIT_MSG/PR_SUMMARY contract markers (agentMarkerMissing=true), the
  // work itself is valid — the model just stopped at a prose summary instead of
  // the structured tail. Salvage by committing+pushing anyway; ensurePr will
  // open a draft PR (failureReason → draft) so the operator can inspect the
  // diff. Without this salvage, hours of agent work get thrown away whenever
  // a model drops the sentinel, which is the worst-of-both outcome — we paid
  // for the run, then discarded the result.
  const markerMissing = ctx.data.agentMarkerMissing === true
  if (ctx.data.agentDone === false && !markerMissing) {
    ctx.data.commitResult = { committed: false, pushed: false, skippedReason: "agentDone=false" }
    ctx.data.hasCommitsAhead = hasCommitsAhead(branch, ctx.config.git.defaultBranch, ctx.cwd)
    return
  }

  if (ctx.data.agentDone === false && markerMissing) {
    // Surface the salvage path for postIssueComment / observability. The
    // commit message falls back to DEFAULT_COMMIT_MESSAGE because the agent
    // didn't supply one — by definition there's no COMMIT_MSG marker.
    ctx.data.salvagedFromMissingMarker = true
  }

  const message = (ctx.data.commitMessage as string) || DEFAULT_COMMIT_MESSAGE
  const deliveryPathAllowlist = Array.isArray(ctx.data.deliveryPathAllowlist)
    ? (ctx.data.deliveryPathAllowlist as string[])
    : []
  const deliveryConfigAllowlist =
    ctx.data.deliveryConfigAllowlist && typeof ctx.data.deliveryConfigAllowlist === "object"
      ? (ctx.data.deliveryConfigAllowlist as Record<string, string[]>)
      : {}

  try {
    const result = doCommitAndPush(
      branch,
      message,
      ctx.cwd,
      deliveryPathAllowlist,
      deliveryConfigAllowlist,
    )
    ctx.data.commitResult = result
    // After a successful commit the working tree is clean, so listChangedFiles
    // (which reads `git status`) returns []. Use the commit's own file list
    // so downstream postflights (verifyFixAlignment) know what we committed.
    // Fall back to working-tree status only if the commit was skipped.
    const postCommitFiles = result.committed ? listFilesInCommit("HEAD", ctx.cwd) : listChangedFiles(ctx.cwd)
    ctx.data.changedFiles = postCommitFiles.filter(
      (f) => !isForbiddenPath(f, deliveryPathAllowlist),
    )

    if (result.committed && !result.pushed) {
      // Commit landed locally but push failed (network, auth, branch
      // protection). Surface as a non-zero exit so the operator sees this
      // explicitly and downstream ensurePr / postIssueComment can branch.
      const reason = result.pushError ?? "push failed (no error detail)"
      ctx.data.commitCrash = reason
      if (ctx.output.exitCode === undefined || ctx.output.exitCode === 0) {
        ctx.output.exitCode = 4
      }
      if (!ctx.output.reason) ctx.output.reason = reason
      process.stderr.write(`[kody commitAndPush] ${reason}\n`)
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.data.commitCrash = reason
    ctx.data.commitResult = { committed: false, pushed: false }
    process.stderr.write(`[kody commitAndPush] failed: ${reason}\n`)
  }

  ctx.data.hasCommitsAhead = hasCommitsAhead(branch, ctx.config.git.defaultBranch, ctx.cwd)

  // Persist the sentinel so a re-entry within the same run replays
  // these results rather than committing twice. Best-effort: write
  // failures don't propagate (no sentinel just means non-idempotent
  // behaviour, same as the legacy path).
  const result = ctx.data.commitResult as { committed?: boolean } | undefined
  if (sentinel && result?.committed) {
    try {
      fs.mkdirSync(path.dirname(sentinel), { recursive: true })
      fs.writeFileSync(
        sentinel,
        JSON.stringify(
          {
            commitResult: ctx.data.commitResult,
            changedFiles: ctx.data.changedFiles,
            hasCommitsAhead: ctx.data.hasCommitsAhead,
            salvagedFromMissingMarker: ctx.data.salvagedFromMissingMarker === true,
            commitCrash: typeof ctx.data.commitCrash === "string" ? ctx.data.commitCrash : undefined,
            exitCode: ctx.output.exitCode,
            reason: ctx.output.reason,
            writtenAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      )
    } catch {
      /* best effort */
    }
  }
}
