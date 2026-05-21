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

/**
 * Lowercased natural-language lead-ins that should NOT be treated as a
 * subcommand attempt. With the firstToken set to one of these words,
 * dispatch falls through to the default executable instead of surfacing
 * the comment as an unrecognized-command error. Keep this small and
 * conservative — every entry weakens the "typo'd command" detection.
 */
const POLITE_WORDS = new Set<string>([
  "please",
  "kindly",
  "hi",
  "hey",
  "hello",
  "thanks",
  "thank",
  "plz",
  "pls",
  "yo",
])

export interface DispatchResult {
  executable: string
  cliArgs: Record<string, unknown>
  target: number
}

/**
 * Typed dispatch outcome. Discriminated union so kody-cli can switch
 * exhaustively on the result instead of treating any null return as
 * "exit cleanly." The previous null-on-failure pattern silently swallowed
 * unrecognized `@kody <token>` comments — the user typed a real command,
 * kody did nothing, no record was left.
 *
 * Variants:
 *   - route: dispatch resolved an executable; run it.
 *   - unrecognized: comment had `@kody <token>` but no executable was
 *     found. The user should be told. Carries the token + the available
 *     options so the comment can suggest alternatives.
 *   - silent: comment was not addressed to kody (no @kody, bot author,
 *     non-issue_comment event with no work to do). Exit cleanly, no log.
 */
export type DispatchOutcome =
  | ({ kind: "route" } & DispatchResult)
  | { kind: "unrecognized"; token: string; target: number; isPr: boolean; available: string[] }
  | { kind: "silent"; reason: string }

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
  // Membership gate: when configured, only commenters whose GitHub
  // author_association is allowlisted may trigger kody. Unset → anyone.
  if (!associationAllowed(event, opts?.config)) return null

  const body = rawBody.toLowerCase()
  const targetNum = Number(event.issue?.number ?? 0)
  const isPr = !!event.issue?.pull_request
  if (!targetNum) return null

  const afterTag = extractAfterTag(body)
  const firstTokenRaw = extractSubcommand(afterTag)
  // Politeness/natural-language words: skip them so "@kody please fix X"
  // routes to the default executable instead of surfacing as unrecognized.
  // Anything not in this small set is assumed to be a command attempt —
  // typo'd or otherwise — and will surface for user feedback.
  const firstToken = firstTokenRaw && POLITE_WORDS.has(firstTokenRaw) ? null : firstTokenRaw

  // Resolve first token via aliases → registry. No match → fall back to the
  // default executable for this event shape (issue vs PR). Alias map comes
  // from config; BUILTIN_ALIASES covers callers that don't pass a config.
  const aliases = opts?.config?.aliases ?? BUILTIN_ALIASES
  const aliased = firstToken ? (aliases[firstToken] ?? firstToken) : null

  let executable: string | null = null
  let consumedFirstToken = false
  if (aliased) {
    if (getProfileInputs(aliased) !== null) {
      executable = aliased
      consumedFirstToken = true
    } else if (firstToken && aliases[firstToken] && aliases[firstToken] === aliased) {
      // The user (or BUILTIN_ALIASES) configured an alias whose target
      // doesn't exist — likely a deleted/renamed executable. Surface this
      // loudly so operators can spot the misconfig in GHA logs.
      // We deliberately only warn for *aliased* targets, not arbitrary
      // typed tokens, so natural language like "@kody please fix X" stays
      // silent (the politeness words get stripped downstream into feedback).
      process.stderr.write(
        `[kody] dispatch: alias '${firstToken}' → '${aliased}' has no matching executable; falling back to default\n`,
      )
    }
  }
  // Fall through to default ONLY when the user did not type a specific
  // subcommand token. If they typed something that didn't resolve (e.g.
  // a typo, a renamed executable), bail with no executable so the typed
  // wrapper can surface the unrecognized comment back to the user. The
  // POLITE_WORDS filter above lets natural-language phrasings through to
  // the default — the "no firstToken" condition here is what gates them.
  if (!executable && !firstToken) {
    executable = isPr ? (opts?.config?.defaultPrExecutable ?? "fix") : (opts?.config?.defaultExecutable ?? null)
  }
  if (!executable) {
    // Surface why dispatch gave up — currently the consumer just sees
    // "no action for event issue_comment" and has no way to tell whether
    // the executable wasn't found, the alias was missing, or there's no
    // default. This breadcrumb makes the gate observable without changing
    // behavior.
    const profileMissing = aliased ? getProfileInputs(aliased) === null : true
    process.stderr.write(
      `[kody] dispatch: no executable resolved for issue_comment ` +
        `(firstToken=${firstToken ?? "<none>"}, aliased=${aliased ?? "<none>"}, ` +
        `profileFound=${!profileMissing}, defaultExecutable=${opts?.config?.defaultExecutable ?? "<unset>"})\n`,
    )
    return null
  }

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
 * Typed-outcome variant of autoDispatch. Instead of "null = anything that
 * didn't route," returns a discriminated union the caller MUST handle
 * exhaustively. The `unrecognized` variant carries the token the user
 * typed and the list of available executables — kody-cli posts a feedback
 * comment in that case so the user gets a clear "I don't know `<token>`"
 * message instead of silent no-op.
 */
export function autoDispatchTyped(opts?: {
  explicit?: { issueNumber?: number }
  config?: KodyConfig
}): DispatchOutcome {
  // Reuse the legacy resolver: for every code path EXCEPT the
  // unrecognized-token branch, the existing logic is right. We only need
  // to re-classify the null returns into typed silent vs unrecognized.
  const legacy = autoDispatch(opts)
  if (legacy) return { kind: "route", ...legacy }

  // Re-derive comment context to distinguish "no @kody mention" (silent)
  // from "@kody <token> but no executable" (unrecognized → user feedback).
  const eventName = process.env.GITHUB_EVENT_NAME
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventName || !eventPath || !fs.existsSync(eventPath)) {
    return { kind: "silent", reason: "no GHA event context" }
  }
  if (eventName !== "issue_comment") {
    return { kind: "silent", reason: `event ${eventName} has no comment to inspect` }
  }
  let event: Record<string, any> = {}
  try {
    event = JSON.parse(fs.readFileSync(eventPath, "utf-8"))
  } catch {
    return { kind: "silent", reason: "GHA event payload unreadable" }
  }
  const rawBody = String(event.comment?.body ?? "")
  const authorLogin = String(event.comment?.user?.login ?? "")
  const authorType = String(event.comment?.user?.type ?? "")
  if (!rawBody.toLowerCase().includes("@kody")) {
    return { kind: "silent", reason: "comment does not mention @kody" }
  }
  if (authorLogin === "kody-bot" || authorType === "Bot") {
    return { kind: "silent", reason: `bot-authored comment (${authorLogin || authorType})` }
  }
  // Membership gate (see autoDispatch). Classify a blocked commenter as
  // silent — not unrecognized — so a non-member typing a real subcommand
  // (e.g. "@kody fix") gets no "I don't know that command" feedback.
  if (!associationAllowed(event, opts?.config)) {
    const assoc = String(event.comment?.author_association ?? "").toUpperCase() || "<none>"
    return { kind: "silent", reason: `commenter association '${assoc}' not in access.allowedAssociations` }
  }
  const targetNum = Number(event.issue?.number ?? 0)
  const isPr = !!event.issue?.pull_request
  if (!targetNum) {
    return { kind: "silent", reason: "comment has no associated issue/PR number" }
  }
  const afterTag = extractAfterTag(rawBody.toLowerCase())
  const tokenRaw = extractSubcommand(afterTag) ?? ""
  // If firstToken is a politeness word, dispatch fell through to default —
  // the legacy null wasn't from "user typo'd a command" but from "no
  // default configured." That's an operator misconfig, not a user error;
  // classify as silent so we don't post a misleading "I don't recognize
  // `please`" comment.
  if (!tokenRaw || POLITE_WORDS.has(tokenRaw)) {
    return { kind: "silent", reason: tokenRaw ? `polite-word lead-in '${tokenRaw}', no default executable configured` : "no subcommand token, no default executable configured" }
  }

  const available = listExecutables()
    .map((e) => e.name)
    .filter((n) => !n.startsWith("goal-") && !n.startsWith("job-"))
    .sort()

  return { kind: "unrecognized", token: tokenRaw, target: targetNum, isPr, available }
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
      } catch (err) {
        // Malformed cron in a profile — skip rather than crash the whole
        // wake, but emit a stderr warning so operators see the misconfig
        // in GHA logs instead of the watch silently never firing.
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(
          `[kody] dispatchScheduledWatches: '${exe.name}' has invalid schedule '${schedule}' (${msg}); never firing\n`,
        )
        continue
      }
    }
    out.push({ executable: exe.name, cliArgs: {}, target: 0 })
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * Membership gate. Returns true (allowed to trigger) unless the config
 * declares a non-empty `access.allowedAssociations` allowlist AND the
 * comment author's GitHub `author_association` is not in it.
 *
 * No allowlist configured → always true (open, current default). The
 * association comes straight off the issue_comment event payload, so this
 * needs no API call and no read:org token.
 */
function associationAllowed(event: Record<string, any>, config?: KodyConfig): boolean {
  const allowed = config?.access?.allowedAssociations
  if (!allowed || allowed.length === 0) return true
  const assoc = String(event.comment?.author_association ?? "").toUpperCase()
  return allowed.includes(assoc)
}

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
  rest = rest.replace(/^(please|kindly)(?:[\s:,.]+|\s|$)/i, "")
  // Strip leading whitespace + punctuation BUT NOT hyphens — hyphens are the
  // flag prefix ("--base dev"). Older regexes included `-` in the class,
  // which silently destroyed comment-supplied flags like `@kody --base X`.
  return rest.replace(/^[\s:,.]+/, "").trim()
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
