/**
 * Postflight (classify-only, runs LAST): hand the chosen sub-orchestrator
 * (feature/bug/spec/chore) to the orchestrator via `ctx.output.nextDispatch`
 * so it runs IN THE SAME PROCESS, and persist classify state before handoff.
 *
 * Why in-process instead of an `@kody <type>` comment:
 *   Classify used to hand off by posting `@kody feature` and relying on a
 *   fresh `issue_comment` run to pick it up. When Kody runs as a GitHub App
 *   that comment is bot-authored, and the follow-up run silently ignores it
 *   (bots can't self-trigger) — so the pipeline deadlocked at classify and
 *   nothing built. Running the next stage in the same process removes the
 *   comment round-trip entirely: no second run, no bot-author gate, no race.
 *
 * State continuity:
 *   The classify action is written to the configured Kody state repo before
 *   the next in-process dispatch runs, so the child sees the same task state
 *   without relying on a GitHub comment as a storage layer.
 */

import type { PostflightScript } from "../implementations/types.js"
import { getProfileInputs } from "../registry.js"
import { type Action, emptyState, reduce, renderStateComment, type TaskState, writeTaskState } from "../state.js"
import { jobMetaFromData } from "./saveTaskState.js"

const VALID_CLASSES = new Set(["feature", "bug", "spec", "chore"])

export const dispatchClassified: PostflightScript = async (ctx, profile) => {
  const issueNumber = ctx.args.issue as number | undefined
  if (!issueNumber) return

  const classification = ctx.data.classification as string | undefined
  if (!classification || !VALID_CLASSES.has(classification)) return

  const action = ctx.data.action as Action | undefined
  if (!action) return

  const base = typeof ctx.args.base === "string" && ctx.args.base.length > 0 ? ctx.args.base : undefined
  // Apply classify's action to in-memory state and persist it before handoff.
  const state = (ctx.data.taskState as TaskState | undefined) ?? emptyState()
  const nextState = reduce(state, "classify", action, undefined, profile.agent, jobMetaFromData(ctx.data))
  ctx.data.taskState = nextState
  ctx.data.taskStateRendered = renderStateComment(nextState)
  await writeTaskState("issue", issueNumber, nextState, ctx.cwd, ctx.config)

  // Hand the chosen sub-orchestrator to kody-cli for in-process execution.
  // Forward `--base` only to stages that declare it (spec does not).
  const cliArgs: Record<string, unknown> = { issue: issueNumber }
  if (base && getProfileInputs(classification)?.some((i) => i.name === "base")) {
    cliArgs.base = base
  }
  ctx.output.nextDispatch = { action: classification, cliArgs }
}
