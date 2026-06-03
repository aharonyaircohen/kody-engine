/**
 * Postflight (classify-only, runs LAST): hand the chosen sub-orchestrator
 * (feature/bug/spec/chore) to the orchestrator via `ctx.output.nextDispatch`
 * so it runs IN THE SAME PROCESS, and post one audit + task-state comment
 * (with `kody:state:v1` markers) for the trail and state continuity.
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
 *   The posted comment carries the rendered state block with the
 *   `kody:state:v1` BEGIN/END markers. The next sub-orchestrator reads it
 *   via `findStateComment` in its preflight and PATCHes it in place. The
 *   comment no longer contains `@kody`, so it can't re-trigger anything.
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript } from "../executables/types.js"
import { getProfileInputs } from "../registry.js"
import { type Action, emptyState, findStateComment, reduce, renderStateComment, type TaskState } from "../state.js"

const API_TIMEOUT_MS = 30_000
const VALID_CLASSES = new Set(["feature", "bug", "spec", "chore"])

export const dispatchClassified: PostflightScript = async (ctx, profile) => {
  const issueNumber = ctx.args.issue as number | undefined
  if (!issueNumber) return

  const classification = ctx.data.classification as string | undefined
  if (!classification || !VALID_CLASSES.has(classification)) return

  const action = ctx.data.action as Action | undefined
  if (!action) return

  const base = typeof ctx.args.base === "string" && ctx.args.base.length > 0 ? ctx.args.base : undefined
  const auditLine =
    (ctx.data.classificationAudit as string | undefined) ?? `🔎 kody classified as \`${classification}\``

  // Apply classify's action to in-memory state and render the state block.
  // The next stage finds this block via the `kody:state:v1` markers and
  // PATCHes the comment in place.
  const state = (ctx.data.taskState as TaskState | undefined) ?? emptyState()
  const nextState = reduce(state, "classify", action, undefined, profile.staff)
  const stateBody = renderStateComment(nextState)
  ctx.data.taskState = nextState
  ctx.data.taskStateRendered = stateBody

  // Post the audit + state comment WITHOUT an `@kody` line — it's a trail and
  // a state anchor, not a trigger. Best-effort: if it fails, the next stage
  // still runs in-process and will create its own state comment.
  //
  // Upsert, don't blindly create: a re-classify (e.g. a second `@kody` on an
  // already-running issue) would otherwise post a SECOND state comment. The
  // canonical one keeps advancing to `shipped` while the duplicate is orphaned
  // at `running`, and the dashboard would flap the card between done/running.
  // So if a state comment already exists, edit it in place instead.
  const body = `${auditLine}\n\n${stateBody}`
  try {
    const existing = findStateComment("issue", issueNumber, ctx.cwd)
    if (existing) {
      execFileSync(
        "gh",
        ["api", `repos/{owner}/{repo}/issues/comments/${existing.id}`, "-X", "PATCH", "-F", "body=@-"],
        {
          cwd: ctx.cwd,
          timeout: API_TIMEOUT_MS,
          input: body,
          stdio: ["pipe", "pipe", "pipe"],
        },
      )
    } else {
      execFileSync("gh", ["issue", "comment", String(issueNumber), "--body", body], {
        cwd: ctx.cwd,
        timeout: API_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      })
    }
  } catch (err) {
    process.stderr.write(
      `[kody dispatchClassified] failed to post state comment for #${issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }

  // Hand the chosen sub-orchestrator to kody-cli for in-process execution.
  // Forward `--base` only to stages that declare it (spec does not).
  const cliArgs: Record<string, unknown> = { issue: issueNumber }
  if (base && getProfileInputs(classification)?.some((i) => i.name === "base")) {
    cliArgs.base = base
  }
  ctx.output.nextDispatch = { executable: classification, cliArgs }
}
