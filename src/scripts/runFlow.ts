/**
 * Flow script for the `run` executable.
 * Loads the issue, creates/checks out a feature branch, posts the "started"
 * comment. Issue number lives in `ctx.args.issue`.
 */

import { ensureFeatureBranch } from "../branch.js"
import type { PreflightScript } from "../executables/types.js"
import { getRunUrl } from "../gha.js"
import { getIssue, postIssueComment } from "../issue.js"

export const runFlow: PreflightScript = async (ctx) => {
  const issueNumber = ctx.args.issue as number

  const issue = getIssue(issueNumber, ctx.cwd)
  ctx.data.issue = issue
  ctx.data.commentTargetType = "issue"
  ctx.data.commentTargetNumber = issueNumber

  // Resolve the base branch:
  //   - Optional --base CLI flag — passed by goal-tick's dispatchNextTask as
  //     `@kody --base <leaf-branch>`. Validated against the kody-task / legacy
  //     goal-branch allowlist so comment-driven dispatch can't redirect kody
  //     onto an arbitrary branch.
  //
  // The umbrella-era label fallback (`goal-runner:dispatched` + `goal:<id>` →
  // `goal-<id>`) is gone: the stacked-PR model doesn't emit those labels,
  // and the --base in the @kody comment is the only signal we need.
  const argBase = resolveBaseOverride(ctx.args.base as string | undefined)
  const baseRaw = ctx.args.base as string | undefined
  if (baseRaw && !argBase) {
    process.stderr.write(`[kody runFlow] ignoring --base "${baseRaw}" (must match kody-task or goal-branch pattern)\n`)
  }
  const base = argBase
  if (base) {
    ctx.data.baseBranch = base
    process.stderr.write(`[kody runFlow] resolved base branch: ${base} (from --base)\n`)
  }

  const branchInfo = ensureFeatureBranch(issueNumber, issue.title, ctx.config.git.defaultBranch, ctx.cwd, base ?? undefined)
  ctx.data.branch = branchInfo.branch

  const runUrl = getRunUrl()
  const startMsg = runUrl
    ? `⚙️ kody started — branch \`${ctx.data.branch}\`, run ${runUrl}`
    : `⚙️ kody started — branch \`${ctx.data.branch}\``
  tryPost(issueNumber, startMsg, ctx.cwd)
}

function tryPost(issueNumber: number, body: string, cwd?: string): void {
  try {
    postIssueComment(issueNumber, body, cwd)
  } catch {
    /* best effort */
  }
}

/**
 * Validate a --base override. Returns the value if it parses as a safe
 * git branch ref, otherwise null. dispatchNextTask is the only intended
 * caller; it passes either the leaf task branch or the repo's default
 * branch (dev, main, etc.), so we need to accept any ordinary branch
 * name without leaving the door open for path-traversal / shell-meta
 * injection.
 *
 * Allowed: lowercase letters, digits, slash, dot, underscore, hyphen.
 * No leading slash/dash/dot; no `..`; max 200 chars.
 */
export function resolveBaseOverride(value: string | undefined): string | null {
  if (!value) return null
  if (value.length > 200) return null
  if (value.includes("..")) return null
  if (!/^[a-z0-9][a-z0-9/._-]*$/.test(value)) return null
  return value
}
