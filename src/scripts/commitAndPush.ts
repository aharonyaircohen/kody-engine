/**
 * Postflight: commit whatever is staged and push the branch. Records the
 * commit result on ctx.data.commitResult for downstream postflights
 * (ensurePr, postIssueComment) to consume.
 *
 * Staging and pre-commit cleanup are the responsibility of earlier
 * postflight entries (e.g. abortUnfinishedGitOps for normal flows,
 * stageMergeConflicts for merge flows). This script does not branch on
 * executable identity.
 *
 * Commit message source (in priority order):
 *   1. ctx.data.commitMessage (agent's COMMIT_MSG line, parsed by parseAgentResult)
 *   2. generic fallback ("chore: kody changes")
 */

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
import type { PostflightScript } from "../executables/types.js"

const DEFAULT_COMMIT_MESSAGE = "chore: kody changes"

/**
 * Sentinel file written by commitAndPush on its first successful execution
 * per task run. A second invocation within the same run (e.g. an
 * accidentally double-wired postflight or a container retry) sees the
 * sentinel, replays the recorded result, and short-circuits — preventing
 * duplicate commits on the agent's branch.
 *
 * Disabled when KODY_COMMIT_IDEMPOTENCY=0.
 */
function sentinelPathForStage(cwd: string, profileName: string): string {
  const runId = resolveRunId()
  return path.join(cwd, ".kody", "runs", runId, `commit-${profileName}.lock`)
}

export const commitAndPush: PostflightScript = async (ctx, profile) => {
  const branch = ctx.data.branch as string | undefined
  if (!branch) {
    ctx.data.commitResult = { committed: false, pushed: false }
    return
  }

  // Idempotency sentinel — short-circuit if this commitAndPush has
  // already run successfully for the same (runId, executable) tuple.
  const idempotencyEnabled = process.env.KODY_COMMIT_IDEMPOTENCY !== "0"
  const sentinel = idempotencyEnabled ? sentinelPathForStage(ctx.cwd, profile.name) : null
  if (sentinel && fs.existsSync(sentinel)) {
    try {
      const replay = JSON.parse(fs.readFileSync(sentinel, "utf-8")) as {
        commitResult?: unknown
        changedFiles?: string[]
        hasCommitsAhead?: boolean
        salvagedFromMissingMarker?: boolean
      }
      ctx.data.commitResult = replay.commitResult ?? { committed: false, pushed: false }
      if (Array.isArray(replay.changedFiles)) ctx.data.changedFiles = replay.changedFiles
      if (typeof replay.hasCommitsAhead === "boolean") ctx.data.hasCommitsAhead = replay.hasCommitsAhead
      if (replay.salvagedFromMissingMarker) ctx.data.salvagedFromMissingMarker = true
      ctx.data.commitIdempotencyReplay = true
      process.stderr.write(`[kody commitAndPush] idempotency replay (sentinel ${sentinel})\n`)
      return
    } catch {
      // Sentinel unreadable — fall through and re-attempt. Safer than
      // crashing on a corrupted lock file.
    }
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

  try {
    const result = doCommitAndPush(branch, message, ctx.cwd)
    ctx.data.commitResult = result
    // After a successful commit the working tree is clean, so listChangedFiles
    // (which reads `git status`) returns []. Use the commit's own file list
    // so downstream postflights (verifyFixAlignment) know what we committed.
    // Fall back to working-tree status only if the commit was skipped.
    const postCommitFiles = result.committed ? listFilesInCommit("HEAD", ctx.cwd) : listChangedFiles(ctx.cwd)
    ctx.data.changedFiles = postCommitFiles.filter((f) => !isForbiddenPath(f))

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
