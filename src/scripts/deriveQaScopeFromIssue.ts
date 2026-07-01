/**
 * Preflight: when qa-engineer is dispatched via workflow_dispatch with
 * `capability=qa-engineer` + `issue_number=<tracking>` (no `--scope` flag),
 * derive the scope from the tracking issue's title.
 *
 * The qa capability creates scoped tracking issues with a fixed shape:
 *   `QA: <scope> (#<source-pr>)`
 *
 * This script parses only that scoped title shape and seeds `ctx.args.scope` so
 * `composePrompt` resolves `{{args.scope}}` exactly as it would have if the
 * dispatcher had passed `--scope "<title>"`. No flag needed, no YAML input,
 * no `@kody` self-dispatch comment — the capability just fires:
 *
 *     gh workflow run kody.yml \
 *       -f capability=qa-engineer \
 *       -f issue_number=<tracking>
 *
 * Pre-existing `ctx.args.scope` is respected — a human running
 * `@kody qa-engineer --scope "..."` keeps full control.
 */

import type { PreflightScript } from "../executables/types.js"
import { getIssue } from "../issue.js"

const TITLE_PATTERN = /^QA:\s*(.+?)(?:\s*\(#\d+\))?\s*$/i

export const deriveQaScopeFromIssue: PreflightScript = async (ctx) => {
  // Caller-supplied scope wins. This script only fills the gap when the
  // dispatcher couldn't pass one (workflow_dispatch has no scope input).
  if (typeof ctx.args.scope === "string" && (ctx.args.scope as string).trim().length > 0) {
    return
  }
  const issueNumber = Number(ctx.args.issue ?? 0)
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) return

  let title = ""
  try {
    const issue = getIssue(issueNumber, ctx.cwd)
    title = (issue.title ?? "").trim()
  } catch (err) {
    // Best-effort: a missing/inaccessible tracking issue isn't fatal. The
    // run continues with no scope and qa-engineer falls back to a broad
    // smoke pass over the discovered routes — the same behavior as the
    // qa-sweep capability.
    process.stderr.write(
      `[kody] deriveQaScopeFromIssue: could not read #${issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return
  }
  if (!title) return

  const m = title.match(TITLE_PATTERN)
  if (!m) return
  const scope = (m[1] ?? "").trim()
  if (!scope) return
  ctx.args.scope = scope
  process.stdout.write(`→ qa-engineer: derived scope from tracking issue #${issueNumber} title: "${scope}"\n`)
}
