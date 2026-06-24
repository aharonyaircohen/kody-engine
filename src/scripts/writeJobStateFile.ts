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
 * silently no-op'ing on a broken agent response. It still advances
 * `lastFiredAt` off the PRIOR state (preserving cursor + data) so a flaky
 * tick — e.g. the agent forgot the `kody-job-next-state` block — degrades to
 * "failed this tick, retry next cadence" instead of wedging the agentResponsibility forever
 * (never advancing, re-firing every cron wake, stuck "overdue" on the dash).
 */

import type { PostflightScript } from "../agent-actions/types.js"
import type { StateEnvelope } from "./issueStateComment.js"
import { type LoadedJobState, resolveBackend } from "./jobState/index.js"

export const writeJobStateFile: PostflightScript = async (ctx, _profile, agentResult, args) => {
  const parseError = ctx.data.nextStateParseError as string | undefined
  if (parseError) {
    process.stderr.write(`[kody] job state write skipped: ${parseError}\n`)
    if (ctx.output.exitCode === 0) ctx.output.exitCode = 1
    if (!ctx.output.reason) ctx.output.reason = `next-state parse failed: ${parseError}`

    // The tick failed to propose a next state, but it must not wedge the agentResponsibility
    // forever. Carry the PRIOR state forward — same cursor + data, so the
    // per-item ledger survives — and only advance lastFiredAt + record the
    // failure. The agentResponsibility then retries on its next cadence instead of re-firing
    // every cron wake and showing permanently "overdue" on the dashboard.
    // First-ever runs (no prior state) have nothing to carry, so leave them
    // to retry next wake as before.
    const prior = ctx.data.jobState as LoadedJobState | undefined
    if (prior) {
      const carried: StateEnvelope = {
        version: 1,
        rev: prior.state.rev + 1,
        cursor: prior.state.cursor,
        data: {
          ...prior.state.data,
          lastFiredAt: new Date().toISOString(),
          lastOutcome: "failed",
          lastDurationMs: agentResult?.durationMs ?? null,
          lastError: parseError,
        },
        done: prior.state.done,
      }
      const jobsDir = String(args?.jobsDir ?? ".kody/agent-responsibilities")
      const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
      await backend.save(prior, carried)
    }
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

  // Stamp `lastFiredAt` so dispatchAgentResponsibilityFileTicks can gate per-agentResponsibility
  // cadence on the next cron wake. Done unconditionally on every save
  // (i.e. every actual tick) — skipped ticks never reach this script.
  //
  // Also stamp the last run's coarse outcome + duration from the agent
  // result, so the dashboard can show "last run failed / took 2m" per agentResponsibility
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
  // single instance — see dispatchAgentResponsibilityFileTicks).
  const jobsDir = String(args?.jobsDir ?? ".kody/agent-responsibilities")
  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  await backend.save(loaded, stamped)
}
