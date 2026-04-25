/**
 * Preflight: stamp `ctx.data.commentTargetType` and `commentTargetNumber`
 * from `ctx.args.issue` (or `ctx.args.pr`) so loadTaskState / saveTaskState /
 * mirrorStateToPr have a target. Used by shell-only executables that don't
 * run a TS flow script (e.g. release-prepare → prepare.sh).
 *
 * Args (from profile entry's `with` object):
 *   - type: "issue" | "pr"  — which arg to read; defaults to "issue"
 */

import type { PreflightScript, ScriptArgs } from "../executables/types.js"

export const setCommentTarget: PreflightScript = async (ctx, _profile, args?: ScriptArgs) => {
  const type = (args?.type as string | undefined) ?? "issue"
  const argName = type === "pr" ? "pr" : "issue"
  const num = ctx.args[argName] as number | undefined
  if (typeof num !== "number" || num <= 0) return
  ctx.data.commentTargetType = type
  ctx.data.commentTargetNumber = num
}
