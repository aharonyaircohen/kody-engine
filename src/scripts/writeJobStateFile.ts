/**
 * Postflight: persist ctx.data.nextJobState via the configured
 * `JobStateBackend`. Mirror of `writeIssueStateComment` for the
 * file-based job model.
 *
 * Backends decide how durability works (contents-API commit, local file,
 * Actions cache, …). This script just relays prev/next; the backend skips
 * no-op writes when state is structurally unchanged.
 *
 * If a prior preflight reported a parse error (ctx.data.nextStateParseError),
 * logs it and surfaces exit code 1 so the run fails loudly rather than
 * silently no-op'ing on a broken agent response.
 */

import type { PostflightScript } from "../executables/types.js"
import type { StateEnvelope } from "./issueStateComment.js"
import { type LoadedJobState, resolveBackend } from "./jobState/index.js"

export const writeJobStateFile: PostflightScript = async (ctx, _profile, agentResult, args) => {
  const parseError = ctx.data.nextStateParseError as string | undefined
  if (parseError) {
    process.stderr.write(`[kody] job state write skipped: ${parseError}\n`)
    if (ctx.output.exitCode === 0) ctx.output.exitCode = 1
    if (!ctx.output.reason) ctx.output.reason = `next-state parse failed: ${parseError}`
    return
  }

  const next = ctx.data.nextJobState as StateEnvelope | undefined
  if (!next) {
    // Agent emitted nothing new; leave the state alone.
    return
  }

  const loaded = ctx.data.jobState as LoadedJobState | undefined
  if (!loaded) {
    throw new Error("writeJobStateFile: ctx.data.jobState missing — preflight must run first")
  }

  // Stamp `lastFiredAt` so dispatchJobFileTicks can gate per-job
  // cadence on the next cron wake. Done unconditionally on every save
  // (i.e. every actual tick) — skipped ticks never reach this script.
  //
  // Also stamp the last run's coarse outcome + duration from the agent
  // result, so the dashboard can show "last run failed / took 2m" per duty
  // without any new file or commit — it rides this existing state write.
  const stamped: StateEnvelope = {
    ...next,
    data: {
      ...next.data,
      lastFiredAt: new Date().toISOString(),
      ...(agentResult
        ? {
            lastOutcome: agentResult.outcome,
            lastDurationMs: agentResult.durationMs ?? null,
          }
        : {}),
    },
  }

  // Backend selection mirrors the preflight load. We re-resolve here rather
  // than pass through ctx.data because the backend is cheap to construct
  // and stateless per-tick (lifecycle state lives on the dispatcher's
  // single instance — see dispatchJobFileTicks).
  const jobsDir = String(args?.jobsDir ?? ".kody/duties")
  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  await backend.save(loaded, stamped)
}
