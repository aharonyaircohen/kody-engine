/**
 * Postflight: persist ctx.data.nextMissionState to the mission's state gist.
 * Mirror of `writeIssueStateComment` for the file-based mission model.
 *
 * If a prior preflight reported a parse error (ctx.data.nextStateParseError),
 * logs it and surfaces exit code 1 so the run fails loudly rather than
 * silently no-op'ing on a broken agent response.
 */

import type { PostflightScript } from "../executables/types.js"
import type { StateEnvelope } from "./issueStateComment.js"
import { type LoadedMissionGist, writeMissionGist } from "./missionGist.js"

export const writeMissionGistState: PostflightScript = async (ctx, _profile, _agentResult) => {
  const parseError = ctx.data.nextStateParseError as string | undefined
  if (parseError) {
    process.stderr.write(`[kody] mission state write skipped: ${parseError}\n`)
    if (ctx.output.exitCode === 0) ctx.output.exitCode = 1
    if (!ctx.output.reason) ctx.output.reason = `next-state parse failed: ${parseError}`
    return
  }

  const next = ctx.data.nextMissionState as StateEnvelope | undefined
  if (!next) {
    // Agent emitted nothing new; leave the gist alone.
    return
  }

  const loaded = ctx.data.missionGist as LoadedMissionGist | undefined
  if (!loaded) {
    throw new Error("writeMissionGistState: ctx.data.missionGist missing — preflight must run first")
  }

  writeMissionGist(loaded.gistId, next, ctx.cwd)
}
