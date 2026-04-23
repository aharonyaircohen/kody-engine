/**
 * Auto-detect which executable to invoke from the GHA event payload and the
 * triggering comment's body.
 *
 * Routing (on an issue):
 *   @kody2 plan        → plan          args: { issue }
 *   @kody2 run         → run           args: { issue }
 *   @kody2 bug         → bug           args: { issue }   (sub-orchestrator)
 *   @kody2 feature     → feature       args: { issue }   (sub-orchestrator)
 *   @kody2 spec        → spec          args: { issue }   (sub-orchestrator)
 *   @kody2 chore       → chore         args: { issue }   (sub-orchestrator)
 *   @kody2 <other>     → <other>       args: { issue }   (generic pass-through)
 *   @kody2 (bare)      → config.defaultExecutable (default baked in by
 *                        loadConfig — currently "classify"; never
 *                        hardcoded here)
 *
 * Routing (on a PR):
 *   @kody2 fix-ci      → fix-ci        args: { pr }
 *   @kody2 resolve     → resolve       args: { pr }
 *   @kody2 ui-review   → ui-review     args: { pr }
 *   @kody2 review      → review        args: { pr }
 *   @kody2 sync        → sync          args: { pr }
 *   @kody2 fix / bare  → fix           args: { pr, feedback? }
 *
 * workflow_dispatch → run on the provided issue_number input.
 */

import * as fs from "node:fs"
import type { Kody2Config } from "./config.js"

export interface DispatchResult {
  /** Which executable to invoke. */
  executable: string
  /** Args to pass to the executable (mirrors what `kody2 <executable>` CLI would receive). */
  cliArgs: Record<string, unknown>
  /** Issue or PR number, surfaced for post-failure comments. */
  target: number
}

/**
 * Explicit override from the CLI (legacy --issue flag): dispatch to the `run`
 * executable on the given issue number.
 */
export function autoDispatch(opts?: {
  explicit?: { issueNumber?: number }
  config?: Kody2Config
}): DispatchResult | null {
  const explicit = opts?.explicit
  if (explicit?.issueNumber && explicit.issueNumber > 0) {
    return {
      executable: "run",
      cliArgs: { issue: explicit.issueNumber },
      target: explicit.issueNumber,
    }
  }

  const eventName = process.env.GITHUB_EVENT_NAME
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventName || !eventPath || !fs.existsSync(eventPath)) return null

  let event: Record<string, any> = {}
  try {
    event = JSON.parse(fs.readFileSync(eventPath, "utf-8"))
  } catch {
    return null
  }

  if (eventName === "workflow_dispatch") {
    const n = parseInt(String(event.inputs?.issue_number ?? ""), 10)
    if (!Number.isNaN(n) && n > 0) {
      return { executable: "run", cliArgs: { issue: n }, target: n }
    }
    return null
  }

  if (eventName !== "issue_comment") return null

  const body = String(event.comment?.body ?? "").toLowerCase()
  const targetNum = Number(event.issue?.number ?? 0)
  const isPr = !!event.issue?.pull_request
  if (!targetNum) return null

  const afterTag = extractAfterTag(body)

  // PR routing: each subcommand is its own executable.
  if (isPr) {
    if (/\bfix-ci\b/.test(afterTag)) {
      return { executable: "fix-ci", cliArgs: { pr: targetNum }, target: targetNum }
    }
    if (/\bresolve\b/.test(afterTag)) {
      return { executable: "resolve", cliArgs: { pr: targetNum }, target: targetNum }
    }
    // `ui-review` must be checked before `review` — `\breview\b` matches
    // "ui-review" (the "-" is a non-word char, so "review" has word
    // boundaries on both sides) and would otherwise win.
    if (/\bui-review\b/.test(afterTag)) {
      return { executable: "ui-review", cliArgs: { pr: targetNum }, target: targetNum }
    }
    if (/\breview\b/.test(afterTag)) {
      return { executable: "review", cliArgs: { pr: targetNum }, target: targetNum }
    }
    if (/\bsync\b/.test(afterTag)) {
      return { executable: "sync", cliArgs: { pr: targetNum }, target: targetNum }
    }
    const feedback = extractFeedback(afterTag)
    return {
      executable: "fix",
      cliArgs: { pr: targetNum, ...(feedback ? { feedback } : {}) },
      target: targetNum,
    }
  }

  // Issue routing: named subcommand wins; bare falls to defaultExecutable.
  // The default is owned by the config layer (see Kody2Config.defaultExecutable
  // / loadConfig) — this module never hardcodes an executable name.
  const sub = extractSubcommand(afterTag)

  if (!sub) {
    const defaultExec = opts?.config?.defaultExecutable
    if (!defaultExec) return null
    return asDispatch(defaultExec, targetNum)
  }

  // Backward-compat aliases that map to other names.
  if (sub === "build") {
    // Legacy: `@kody2 build` on an issue used to mean implement-the-issue.
    return { executable: "run", cliArgs: { issue: targetNum }, target: targetNum }
  }
  if (sub === "orchestrate" || sub === "orchestrator") {
    // Legacy: bare `@kody2 orchestrate` used to mean the plan-build-review
    // flow. Route to its semantic successor, `bug`.
    return { executable: "bug", cliArgs: { issue: targetNum }, target: targetNum }
  }

  // Generic pass-through: @kody2 <name> → executable <name> with { issue }.
  // Sub-orchestrators (bug, feature, spec, chore, …) route through here.
  return asDispatch(sub, targetNum)
}

function asDispatch(executable: string, target: number): DispatchResult {
  return { executable, cliArgs: { issue: target }, target }
}

function extractAfterTag(body: string): string {
  const idx = body.indexOf("@kody2")
  if (idx === -1) return body
  return body.slice(idx + "@kody2".length).trim()
}

/**
 * Extract the first word after `@kody2` — the subcommand (e.g. "plan", "run").
 * Returns null if no recognizable subcommand (i.e. bare `@kody2` or free text).
 */
function extractSubcommand(afterTag: string): string | null {
  const match = afterTag.match(/^([a-z][a-z0-9-]{1,40})\b/)
  if (!match) return null
  return match[1]!
}

function extractFeedback(afterTag: string): string | undefined {
  // Strip an optional leading "fix" / "please" / "kindly" keyword whether it
  // is followed by a separator or stands alone at end-of-string. Without the
  // `|$` alternative, bare `@kody2 fix` returned "fix" as inline feedback,
  // causing fixFlow to bypass the actual PR review body.
  const cleaned = afterTag.replace(/^(fix|please|kindly)(?:[\s:,.-]+|$)/i, "").trim()
  return cleaned.length > 0 ? cleaned : undefined
}
