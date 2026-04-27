/**
 * Route a GitHub event / CLI invocation to an executable.
 *
 * Dispatch contains ZERO executable names. What to route where comes from:
 *   - the comment body (first token after `@kody`),
 *   - the matched profile's declared `inputs[]` (what args it accepts),
 *   - `config.aliases` (typed word → executable name),
 *   - `config.defaultExecutable` / `config.defaultPrExecutable` (bare fallback).
 *
 * Adding a new executable = drop a `src/executables/<name>/profile.json`.
 * No edits here. Utilities that take no `issue`/`pr` work because we only
 * inject those args when the profile declares them.
 */

import * as fs from "node:fs"
import { BUILTIN_ALIASES, type KodyConfig } from "./config.js"
import { cronMatchesInWindow } from "./cron-match.js"
import type { InputSpec } from "./executables/types.js"
import { getProfileInputs, listExecutables } from "./registry.js"

export interface DispatchResult {
  executable: string
  cliArgs: Record<string, unknown>
  target: number
}

/**
 * Explicit CLI override (legacy --issue flag): route to the `run` executable.
 * Intentionally the one hardcoded path — it exists to support the historical
 * `kody --issue N` shorthand and has no comment-dispatch analogue.
 */
export function autoDispatch(opts?: {
  explicit?: { issueNumber?: number }
  config?: KodyConfig
}): DispatchResult | null {
  const explicit = opts?.explicit
  if (explicit?.issueNumber && explicit.issueNumber > 0) {
    return { executable: "run", cliArgs: { issue: explicit.issueNumber }, target: explicit.issueNumber }
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
    // No issue_number input → manual force-fire of all watch executables.
    // The CLI handles this the same way as a schedule event but with the
    // cron filter bypassed (humans want to test "now"). Returning null
    // signals "fan out via dispatchScheduledWatches({ force: true })".
    return null
  }

  // Cron-driven wakes are not handled here — they fire many executables
  // (every watch whose `schedule` matches the wake window), not one. The
  // CLI calls dispatchScheduledWatches() instead and iterates the result.
  if (eventName === "schedule") return null

  // PR-merge events are no longer routed here for release: the `release`
  // orchestrator merges its own PR via `mergeReleasePr` and then dispatches
  // release-publish + release-deploy. A human merging a release PR manually
  // doesn't auto-finalize; they'd run `kody release-publish` directly or
  // re-trigger `@kody release` on the originating issue.
  if (eventName === "pull_request") return null

  if (eventName !== "issue_comment") return null

  // Gate on @kody mention + non-bot author here so the consumer workflow
  // YAML stays trigger-only (no routing logic leaks). Returning null lets
  // kody-cli exit 0 cleanly instead of running the agent on unrelated chatter.
  const rawBody = String(event.comment?.body ?? "")
  const authorLogin = String(event.comment?.user?.login ?? "")
  const authorType = String(event.comment?.user?.type ?? "")
  if (!rawBody.toLowerCase().includes("@kody")) return null
  if (authorLogin === "kody-bot" || authorType === "Bot") return null

  const body = rawBody.toLowerCase()
  const targetNum = Number(event.issue?.number ?? 0)
  const isPr = !!event.issue?.pull_request
  if (!targetNum) return null

  const afterTag = extractAfterTag(body)
  const firstToken = extractSubcommand(afterTag)

  // Resolve first token via aliases → registry. No match → fall back to the
  // default executable for this event shape (issue vs PR). Alias map comes
  // from config; BUILTIN_ALIASES covers callers that don't pass a config.
  const aliases = opts?.config?.aliases ?? BUILTIN_ALIASES
  const aliased = firstToken ? (aliases[firstToken] ?? firstToken) : null

  let executable: string | null = null
  let consumedFirstToken = false
  if (aliased && getProfileInputs(aliased) !== null) {
    executable = aliased
    consumedFirstToken = true
  }
  if (!executable) {
    executable = isPr ? (opts?.config?.defaultPrExecutable ?? "fix") : (opts?.config?.defaultExecutable ?? null)
  }
  if (!executable) return null

  // Inputs drive arg parsing and injection. If the profile isn't registered
  // (e.g. a consumer-configured default pointing at something not bundled),
  // fall back to event-shape injection so context isn't silently dropped.
  const inputs = getProfileInputs(executable)
  const effectiveInputs = inputs ?? []
  const unknownProfile = inputs === null
  const rest = extractCommentRest(afterTag, consumedFirstToken ? firstToken : null)
  const { args, leftover } = parseCommentArgs(rest, effectiveInputs)

  if (isPr && (unknownProfile || effectiveInputs.some((s) => s.name === "pr"))) {
    args.pr = targetNum
  } else if (!isPr && (unknownProfile || effectiveInputs.some((s) => s.name === "issue"))) {
    args.issue = targetNum
  }

  const restInput = effectiveInputs.find((s) => s.bindsCommentRest === true)
  if (restInput && leftover.length > 0 && args[restInput.name] === undefined) {
    args[restInput.name] = leftover
  }

  return { executable, cliArgs: args, target: targetNum }
}

/**
 * Fan-out for scheduled wakes. Returns a DispatchResult per watch executable
 * (`role: "watch"`, `kind: "scheduled"`) whose `schedule` cron matched any
 * minute in the wake window `(now - windowSec, now]`. With `force: true`
 * the cron filter is skipped — used when a human runs workflow_dispatch
 * manually to fire every watch right now.
 *
 * Window default: `KODY_SCHEDULE_WINDOW_SEC` env var, else 300s. The
 * window absorbs GitHub Actions cron drift; pick something ≥ the workflow's
 * own wake interval.
 *
 * The list is sorted by name for deterministic ordering. The CLI runs each
 * sequentially; per-watch failures don't stop the rest.
 */
export function dispatchScheduledWatches(opts?: { now?: Date; windowSec?: number; force?: boolean }): DispatchResult[] {
  const now = opts?.now ?? new Date()
  const envWindow = Number(process.env.KODY_SCHEDULE_WINDOW_SEC)
  const windowSec = opts?.windowSec ?? (Number.isFinite(envWindow) && envWindow > 0 ? envWindow : 300)
  const out: DispatchResult[] = []
  for (const exe of listExecutables()) {
    let raw: string
    try {
      raw = fs.readFileSync(exe.profilePath, "utf-8")
    } catch {
      continue
    }
    let profile: Record<string, unknown>
    try {
      profile = JSON.parse(raw) as Record<string, unknown>
    } catch {
      continue
    }
    if (profile.role !== "watch") continue
    if (profile.kind !== "scheduled") continue
    const schedule = profile.schedule
    if (typeof schedule !== "string" || schedule.trim().length === 0) continue
    if (!opts?.force) {
      try {
        if (!cronMatchesInWindow(schedule, now, windowSec)) continue
      } catch {
        // Malformed cron in a profile — skip rather than crash the whole wake.
        continue
      }
    }
    out.push({ executable: exe.name, cliArgs: {}, target: 0 })
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────

function extractAfterTag(body: string): string {
  const idx = body.indexOf("@kody")
  if (idx === -1) return body
  return body.slice(idx + "@kody".length).trim()
}

function extractSubcommand(afterTag: string): string | null {
  const match = afterTag.match(/^([a-z][a-z0-9-]{1,40})\b/)
  return match ? match[1]! : null
}

/**
 * Remove the matched subcommand (if any) and common politeness lead-ins,
 * then trim leading punctuation. What's left is the user's free text /
 * flag soup that will be parsed against the profile's inputs.
 */
function extractCommentRest(afterTag: string, consumedToken: string | null): string {
  let rest = afterTag
  if (consumedToken) {
    const re = new RegExp(`^${consumedToken.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i")
    rest = rest.replace(re, "")
  }
  rest = rest.replace(/^(please|kindly)(?:[\s:,.-]+|$)/i, "")
  return rest.replace(/^[\s:,.-]+/, "").trim()
}

/**
 * Parse free text against a profile's declared inputs. Recognizes:
 *   --flag value | --flag=value   — any declared input
 *   --bool-flag                   — type: "bool"
 *   bare enum values              — type: "enum", matches InputSpec.values
 *   bare integer                  — type: "int"
 *   bare bool-flag keyword        — type: "bool", matches the flag word
 *
 * Unrecognized tokens accumulate in `leftover`, which callers may forward
 * to a `bindsCommentRest` input.
 */
function parseCommentArgs(rest: string, inputs: InputSpec[]): { args: Record<string, unknown>; leftover: string } {
  const tokens = rest.length === 0 ? [] : rest.split(/\s+/).filter((t) => t.length > 0)
  const args: Record<string, unknown> = {}
  const unmatched: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!

    if (t.startsWith("--")) {
      const eq = t.indexOf("=")
      const key = eq >= 0 ? t.slice(2, eq) : t.slice(2)
      const inlineValue = eq >= 0 ? t.slice(eq + 1) : undefined
      const spec = findInputByFlag(inputs, key)
      if (!spec) {
        unmatched.push(t)
        continue
      }
      if (spec.type === "bool") {
        args[spec.name] = true
        continue
      }
      const value = inlineValue ?? tokens[i + 1]
      if (value === undefined || value.startsWith("--")) {
        unmatched.push(t)
        continue
      }
      args[spec.name] = coerceBare(spec, value)
      if (inlineValue === undefined) i++
      continue
    }

    const enumHit = inputs.find((s) => s.type === "enum" && s.values?.includes(t) && args[s.name] === undefined)
    if (enumHit) {
      args[enumHit.name] = t
      continue
    }

    if (/^-?\d+$/.test(t)) {
      const intHit = inputs.find((s) => s.type === "int" && args[s.name] === undefined)
      if (intHit) {
        args[intHit.name] = parseInt(t, 10)
        continue
      }
    }

    const boolHit = inputs.find((s) => s.type === "bool" && s.flag === `--${t}` && args[s.name] === undefined)
    if (boolHit) {
      args[boolHit.name] = true
      continue
    }

    unmatched.push(t)
  }

  return { args, leftover: unmatched.join(" ") }
}

function findInputByFlag(inputs: InputSpec[], key: string): InputSpec | undefined {
  return inputs.find((s) => s.name === key || s.flag === `--${key}`)
}

function coerceBare(spec: InputSpec, value: string): unknown {
  if (spec.type === "int") {
    const n = parseInt(value, 10)
    return Number.isNaN(n) ? value : n
  }
  if (spec.type === "bool") {
    const v = value.toLowerCase()
    return v === "true" || v === "1" || v === "yes"
  }
  return value
}
