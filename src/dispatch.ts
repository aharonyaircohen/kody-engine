/**
 * Auto-detect which executable to invoke from the GHA event payload and the
 * triggering comment's body.
 *
 * Routing (on an issue):
 *   @kody2 plan        → plan          args: { issue }
 *   @kody2 build       → build (run)   args: { mode: "run", issue }
 *   @kody2 orchestrate → orchestrator  args: { issue }
 *   @kody2 <other>     → <other>       args: { issue }   (generic pass-through)
 *   @kody2 (bare)      → config.defaultExecutable (fallback: "build" as run mode)
 *
 * Routing (on a PR):
 *   @kody2 fix-ci      → build (fix-ci)
 *   @kody2 resolve     → build (resolve)
 *   @kody2 fix / bare  → build (fix) with extracted feedback
 *
 * workflow_dispatch → build (run) on the provided issue_number input.
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
 * Explicit override from the CLI (legacy --issue flag): dispatch to build/run
 * mode on the given issue number.
 */
export function autoDispatch(opts?: {
  explicit?: { issueNumber?: number }
  config?: Kody2Config
}): DispatchResult | null {
  const explicit = opts?.explicit
  if (explicit?.issueNumber && explicit.issueNumber > 0) {
    return {
      executable: "build",
      cliArgs: { mode: "run", issue: explicit.issueNumber },
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
      return { executable: "build", cliArgs: { mode: "run", issue: n }, target: n }
    }
    return null
  }

  if (eventName !== "issue_comment") return null

  const body = String(event.comment?.body ?? "").toLowerCase()
  const targetNum = Number(event.issue?.number ?? 0)
  const isPr = !!event.issue?.pull_request
  if (!targetNum) return null

  const afterTag = extractAfterTag(body)

  // PR routing: keep build-mode semantics (fix / fix-ci / resolve).
  if (isPr) {
    if (/\bfix-ci\b/.test(afterTag)) {
      return { executable: "build", cliArgs: { mode: "fix-ci", pr: targetNum }, target: targetNum }
    }
    if (/\bresolve\b/.test(afterTag)) {
      return { executable: "build", cliArgs: { mode: "resolve", pr: targetNum }, target: targetNum }
    }
    const feedback = extractFeedback(afterTag)
    return {
      executable: "build",
      cliArgs: { mode: "fix", pr: targetNum, ...(feedback ? { feedback } : {}) },
      target: targetNum,
    }
  }

  // Issue routing: named subcommand wins; bare falls to defaultExecutable.
  const sub = extractSubcommand(afterTag)
  const defaultExec = opts?.config?.defaultExecutable ?? "build"

  if (!sub) {
    return asDispatch(defaultExec, targetNum)
  }

  // Known sub-aliases.
  if (sub === "build") {
    return { executable: "build", cliArgs: { mode: "run", issue: targetNum }, target: targetNum }
  }
  if (sub === "orchestrate" || sub === "orchestrator") {
    return { executable: "orchestrator", cliArgs: { issue: targetNum }, target: targetNum }
  }

  // Generic pass-through: @kody2 <name> → executable <name> with { issue }.
  return asDispatch(sub, targetNum)
}

function asDispatch(executable: string, target: number): DispatchResult {
  if (executable === "build") {
    return { executable, cliArgs: { mode: "run", issue: target }, target }
  }
  return { executable, cliArgs: { issue: target }, target }
}

function extractAfterTag(body: string): string {
  const idx = body.indexOf("@kody2")
  if (idx === -1) return body
  return body.slice(idx + "@kody2".length).trim()
}

/**
 * Extract the first word after `@kody2` — the subcommand (e.g. "plan", "build").
 * Returns null if no recognizable subcommand (i.e. bare `@kody2` or free text).
 */
function extractSubcommand(afterTag: string): string | null {
  const match = afterTag.match(/^([a-z][a-z0-9-]{1,40})\b/)
  if (!match) return null
  return match[1]!
}

function extractFeedback(afterTag: string): string | undefined {
  const cleaned = afterTag.replace(/^(fix|please|kindly)[\s:,.-]+/i, "").trim()
  return cleaned.length > 0 ? cleaned : undefined
}
