/**
 * Postflight: open or update the PR. Draft on any failure, normal on full success.
 *
 * ALWAYS sets `ctx.data.prResult` to a typed PrOutcome — Created / Updated /
 * Skipped / Crashed — even when this postflight chooses not to call gh. This
 * eliminates the "downstream consumer can't tell whether ensurePr ran" class
 * of bug: postIssueComment can switch exhaustively instead of templating
 * undefined into a success message ("✅ kody PR opened: undefined").
 */

import type { PostflightScript } from "../implementations/types.js"
import { ensurePr as doEnsurePr } from "../pr.js"
import type { PrOutcome } from "./prOutcome.js"

function setOutcome(ctx: Parameters<PostflightScript>[0], outcome: PrOutcome): void {
  ctx.data.prResult = outcome
  if (outcome.kind === "created" || outcome.kind === "updated") {
    ctx.output.prUrl = outcome.url
  }
}

export const ensurePr: PostflightScript = async (ctx) => {
  if (ctx.skipAgent && ctx.output.exitCode !== undefined) {
    // Preflight was authoritative — either it refused to start (exit != 0)
    // or it did the work itself and short-circuited (exit === 0).
    setOutcome(ctx, { kind: "skipped", reason: "preflight short-circuited (skipAgent)" })
    return
  }

  const commitResult = ctx.data.commitResult as { committed: boolean; pushed?: boolean } | undefined
  const hasCommits = Boolean(ctx.data.hasCommitsAhead)
  if (!commitResult?.committed && !hasCommits) {
    setOutcome(ctx, { kind: "skipped", reason: "no commits to ship" })
    return
  }

  // Local commit succeeded but push failed (commitAndPush surfaced this via
  // exitCode=4). Don't try to open a PR — gh would 422 against a branch that
  // origin has never seen.
  if (commitResult?.committed && commitResult.pushed === false) {
    setOutcome(ctx, { kind: "skipped", reason: "local commit succeeded but push failed" })
    return
  }

  // Gate previously enforced via profile runWhen={data.verifyOk:true}, but
  // that left ctx.data.prResult unset when verifyOk was undefined or false —
  // postIssueComment then templated "${prUrl}" as the literal string
  // "undefined" because it had no signal that ensurePr was skipped.
  // Keeping the gate inline guarantees a typed outcome in every code path.
  //
  // Only gate when the caller's profile actually ran the verify postflight
  // (signaled by verifyOk being a boolean). Profiles like `resolve` and
  // `revert` never run verify; for them, ensurePr proceeds unconditionally.
  if (ctx.data.verifyOk === false) {
    const reason = `verify failed: ${(ctx.data.verifyReason as string | undefined) ?? "unknown"}`
    setOutcome(ctx, { kind: "skipped", reason })
    return
  }

  const branch = ctx.data.branch as string | undefined
  if (!branch) {
    setOutcome(ctx, { kind: "skipped", reason: "no branch context (ctx.data.branch missing)" })
    return
  }

  const failureReason = computeFailureReason(ctx)
  const isFailure = failureReason.length > 0
  const changedFiles = (ctx.data.changedFiles as string[] | undefined) ?? []

  const issue = ctx.data.issue as { title?: string } | undefined
  const pr = ctx.data.pr as { title?: string } | undefined
  const targetNumber = Number(ctx.data.commentTargetNumber ?? 0)
  const title = issue?.title ?? pr?.title ?? `kody changes`

  // baseBranch is set by runFlow when --base passed validation. Anything else
  // (including a comment-supplied value that didn't match the allowlist) is
  // dropped before reaching here, so passing through is safe.
  const baseBranch = ctx.data.baseBranch as string | undefined

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
      baseBranch,
      // No fresh commit this run → don't rebuild the body of an existing PR;
      // it would replace the original agent summary with the empty fallback.
      preserveBodyOnUpdate: !commitResult?.committed,
      cwd: ctx.cwd,
    })
    // Boundary assertion: gh pr create returning an empty URL is not a
    // success we should claim — fail closed with a Crashed outcome so
    // postIssueComment surfaces the truth instead of "PR opened: undefined".
    if (!result.url || result.url.trim().length === 0) {
      const reason = `gh pr create returned empty URL (action=${result.action}); refusing to claim success`
      ctx.data.prCrashReason = reason
      ctx.output.exitCode = 4
      ctx.output.reason = reason
      setOutcome(ctx, { kind: "crashed", reason })
      return
    }
    setOutcome(ctx, {
      kind: result.action === "created" ? "created" : "updated",
      url: result.url,
      number: result.number,
      draft: result.draft,
    })
  } catch (err) {
    const reason = `PR creation failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.data.prCrashReason = reason
    ctx.output.exitCode = 4
    ctx.output.reason = reason
    setOutcome(ctx, { kind: "crashed", reason })
  }
}

function computeFailureReason(ctx: { data: Record<string, unknown> }): string {
  const expectedTests = collectExpectedTests(ctx.data.coverageMisses)
  if (expectedTests.length > 0) return `missing tests: ${expectedTests.join(", ")}`

  const agentDone = Boolean(ctx.data.agentDone)
  if (!agentDone) {
    return (
      (ctx.data.agentFailureReason as string) ||
      (ctx.data.agentError as string) ||
      (ctx.data.commitCrash as string) ||
      actionFailureReason(ctx.data.action) ||
      "agent did not emit DONE"
    )
  }

  if (ctx.data.verifyOk === false) return (ctx.data.verifyReason as string) || "verify failed"

  return ""
}

function actionFailureReason(action: unknown): string {
  if (!action || typeof action !== "object" || Array.isArray(action)) return ""
  const payload = (action as { payload?: unknown }).payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return ""
  const reason = (payload as { reason?: unknown }).reason
  return typeof reason === "string" ? reason : ""
}

/**
 * Defensive coverage-miss extractor.
 *
 * Historically this code read `m.expectedTest` directly. If the upstream
 * shape ever drifts (e.g. `expected` instead of `expectedTest`), the strict
 * read would silently produce "undefined, undefined, undefined" without
 * any warning, and ensurePr would open a non-draft PR despite real test
 * gaps. We now defensively look for `expectedTest`, `expected`, or `file`
 * (in priority order), and log a warning when items can't be parsed.
 *
 * Exported for unit tests; the production caller is `computeFailureReason`.
 */
export function collectExpectedTests(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return []
  const out: string[] = []
  let unparseable = 0
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      unparseable++
      continue
    }
    const r = item as Record<string, unknown>
    const candidate = r.expectedTest ?? r.expected ?? r.file
    if (typeof candidate === "string" && candidate.length > 0) out.push(candidate)
    else unparseable++
  }
  if (unparseable > 0) {
    process.stderr.write(
      `[kody] ensurePr: ${unparseable} coverageMisses entry/entries had no recognizable test path — shape may have drifted\n`,
    )
  }
  return out
}
