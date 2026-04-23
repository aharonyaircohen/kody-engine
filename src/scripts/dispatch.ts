/**
 * Postflight (orchestrator-only): post `@kody <next>` to either the issue
 * or the PR, advancing `state.flow.step`. Pure dispatcher — assumes the
 * triggering `runWhen` already gated this entry.
 *
 * Args (from profile entry's `with` object):
 *   - next:   child executable to invoke (e.g. "run", "review", "fix")
 *   - target: "issue" | "pr" — where to post the comment. PR targets need
 *             state.core.prUrl to be set; otherwise falls back to the issue.
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript, ScriptArgs } from "../executables/types.js"
import type { TaskState } from "../state.js"

const API_TIMEOUT_MS = 30_000

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

  if (state?.flow) {
    state.flow.step = next
  }

  const usePr = target === "pr" && state?.core.prUrl
  const targetNumber = usePr ? parsePr(state!.core.prUrl!) ?? issueNumber : issueNumber
  const sub = usePr ? "pr" : "issue"
  const body = `@kody ${next}`

  try {
    execFileSync("gh", [sub, "comment", String(targetNumber), "--body", body], {
      timeout: API_TIMEOUT_MS,
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    process.stderr.write(
      `[kody dispatch] failed to post @kody ${next} on ${sub} #${targetNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}

function parsePr(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : null
}
