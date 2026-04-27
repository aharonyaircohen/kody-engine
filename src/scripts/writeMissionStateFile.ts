/**
 * Postflight: persist ctx.data.nextMissionState into the mission's state file
 * in the consumer repo. Mirror of `writeIssueStateComment` for the file-based
 * mission model.
 *
 * Skips the commit when the agent's state is structurally identical to the
 * prior state (idle ticks don't churn the git log).
 *
 * If a prior preflight reported a parse error (ctx.data.nextStateParseError),
 * logs it and surfaces exit code 1 so the run fails loudly rather than
 * silently no-op'ing on a broken agent response.
 */

import type { PostflightScript } from "../executables/types.js"
import type { StateEnvelope } from "./issueStateComment.js"
import { type LoadedMissionState, writeMissionState } from "./missionStateFile.js"

export const writeMissionStateFile: PostflightScript = async (ctx, _profile, _agentResult) => {
  const parseError = ctx.data.nextStateParseError as string | undefined
  if (parseError) {
    process.stderr.write(`[kody] mission state write skipped: ${parseError}\n`)
    if (ctx.output.exitCode === 0) ctx.output.exitCode = 1
    if (!ctx.output.reason) ctx.output.reason = `next-state parse failed: ${parseError}`
    return
  }

  const next = ctx.data.nextMissionState as StateEnvelope | undefined
  if (!next) {
    // Agent emitted nothing new; leave the state file alone.
    return
  }

  const loaded = ctx.data.missionState as LoadedMissionState | undefined
  if (!loaded) {
    throw new Error("writeMissionStateFile: ctx.data.missionState missing — preflight must run first")
  }

  const owner = ctx.config.github.owner
  const repo = ctx.config.github.repo
  if (!owner || !repo) {
    throw new Error("writeMissionStateFile: ctx.config.github.owner/repo must be set")
  }

  writeMissionState(owner, repo, loaded, next, ctx.cwd)
}
