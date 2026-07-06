/**
 * Postflight (orchestrator-only): hand the next stage to kody-cli via
 * `ctx.output.nextDispatch` (run in-process), advancing `state.flow.step`.
 * Pure dispatcher — assumes the triggering `runWhen` already gated this entry.
 *
 * Why in-process instead of an `@kody <next>` comment: when Kody runs as a
 * GitHub App the comment is bot-authored and the follow-up run silently
 * ignores it (bots can't self-trigger), stalling the flow. Running the next
 * stage in the same process removes that round-trip.
 *
 * Args (from profile entry's `with` object):
 *   - next:   child implementation to invoke (e.g. "run", "review", "fix")
 *   - target: "issue" | "pr" — which target the child runs against. When
 *             target is "pr" but `state.core.prUrl` is missing, the dispatch
 *             is aborted (the child profile would reject `--issue` anyway). A
 *             synthetic AGENT_NOT_RUN outcome is written so the orchestrator's
 *             existing `aborted` finishFlow runWhen catches it and clears
 *             `kody:orchestrating`.
 */

import type { PostflightScript, ScriptArgs } from "../implementations/types.js"
import type { Action, TaskState } from "../state.js"

export const dispatch: PostflightScript = async (ctx, _profile, _agentResult, args?: ScriptArgs) => {
  const next = args?.next as string | undefined
  if (!next) {
    process.stderr.write("[kody dispatch] missing `with.next` — skipping\n")
    return
  }
  const target = (args?.target as string | undefined) ?? "issue"

  const issueNumber = ctx.args.issue as number | undefined
  if (!issueNumber) {
    process.stderr.write("[kody dispatch] no --issue arg — skipping\n")
    return
  }

  const state = ctx.data.taskState as TaskState | undefined

  // target=pr requires a PR. Falling back to the issue would route to a
  // profile (e.g. review) that doesn't accept `--issue`, surfacing as
  // "required input missing: --pr" deep in the executor. Abort cleanly
  // instead and let the orchestrator's aborted finishFlow handle cleanup.
  if (target === "pr" && !state?.core.prUrl) {
    const reason = `cannot dispatch @kody ${next}: target=pr but state.core.prUrl is not set`
    process.stderr.write(`[kody dispatch] ${reason}\n`)
    const action: Action = {
      type: "AGENT_NOT_RUN",
      payload: { reason, dispatchTarget: "pr", next },
      timestamp: new Date().toISOString(),
    }
    ctx.data.action = action
    if (state) state.core.lastOutcome = action
    return
  }

  if (state?.flow) {
    state.flow.step = next
  }

  const usePr = target === "pr" && state?.core.prUrl
  const targetNumber = usePr ? (parsePr(state!.core.prUrl!) ?? issueNumber) : issueNumber

  // In-process hand-off to the next stage (kody-cli runs it, reusing the
  // preflight). The child runs against the PR or the issue depending on target.
  ctx.output.nextDispatch = {
    action: next,
    cliArgs: usePr ? { pr: targetNumber } : { issue: targetNumber },
  }
}

function parsePr(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : null
}
