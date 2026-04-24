/**
 * Postflight (orchestrator-only): seed `state.flow` if not already set, then
 * dispatch the first child executable. Idempotent — if a flow is already in
 * progress for this issue, no-op.
 *
 * Args (from profile entry's `with` object):
 *   - entry: name of the first child executable to invoke (e.g. "plan")
 *   - target: "issue" | "pr" — where to post the @kody comment
 *
 * Reads:
 *   - profile.name       — orchestrator's own executable name, which IS
 *                           the flow name (e.g. "bug", "feature", "spec")
 *   - ctx.args.issue     — orchestrator's --issue input
 *   - ctx.data.taskState — loaded by `loadTaskState` preflight
 *
 * Writes:
 *   - ctx.data.taskState.flow — initialized
 *   - posts an `@kody <entry>` comment via `gh`
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript, ScriptArgs } from "../executables/types.js"
import { parsePrNumber } from "../issue.js"
import type { TaskState } from "../state.js"

const API_TIMEOUT_MS = 30_000

export const startFlow: PostflightScript = async (ctx, profile, _agentResult, args?: ScriptArgs) => {
  const entry = args?.entry as string | undefined
  if (!entry) {
    process.stderr.write("[kody startFlow] missing `with.entry` — skipping\n")
    return
  }
  const target = (args?.target as string | undefined) ?? "issue"

  // Flow name = orchestrator's own executable name. This is what advanceFlow
  // posts back (`@kody <flow-name>`) to retrigger the same sub-orchestrator.
  const flowName = profile.name
  const issueNumber = ctx.args.issue as number | undefined
  if (!issueNumber) {
    process.stderr.write("[kody startFlow] no --issue arg — skipping\n")
    return
  }

  const state = ctx.data.taskState as TaskState | undefined
  if (state?.flow) {
    // Already in flight; nothing to seed.
    return
  }

  if (state) {
    state.flow = {
      name: flowName,
      step: entry,
      issueNumber,
      startedAt: new Date().toISOString(),
    }
  }

  postKodyComment(target, issueNumber, state, entry, ctx.cwd)
}

function postKodyComment(
  target: string,
  issueNumber: number,
  state: TaskState | undefined,
  next: string,
  cwd: string,
): void {
  const targetNumber = target === "pr" && state?.core.prUrl ? parsePrNumber(state.core.prUrl) ?? issueNumber : issueNumber
  const sub = target === "pr" && state?.core.prUrl ? "pr" : "issue"
  const body = `@kody ${next}`
  try {
    execFileSync("gh", [sub, "comment", String(targetNumber), "--body", body], {
      timeout: API_TIMEOUT_MS,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    process.stderr.write(
      `[kody startFlow] failed to post @kody ${next} on ${sub} #${targetNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}

