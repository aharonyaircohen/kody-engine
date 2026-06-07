/**
 * Tiny YAML-frontmatter parser/serializer for duty files.
 *
 * Duty markdown at `.kody/duties/<slug>.md` may begin with a `---\n…\n---\n`
 * block carrying flat scalar key/value pairs (no nesting, no flow style).
 * Recognized fields are `every:` (cadence), `disabled:`, `tickScript:`, and
 * `staff:` (the executor persona). The parser silently ignores unknown keys
 * so the dashboard and engine can evolve the frontmatter independently.
 *
 * Mirror of the dashboard's ticked-frontmatter parser in Kody-Dashboard —
 * keep the two in sync if the format grows.
 */

export type ScheduleEvery =
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "6h"
  | "12h"
  | "1d"
  | "3d"
  | "7d"
  /**
   * Sentinel: the scheduler never auto-fires this job. Only manual triggers
   * (workflow_dispatch via the dashboard "Run now" button) execute it.
   */
  | "manual"

const SCHEDULE_EVERY_VALUES: readonly ScheduleEvery[] = [
  "15m",
  "30m",
  "1h",
  "2h",
  "6h",
  "12h",
  "1d",
  "3d",
  "7d",
  "manual",
] as const

export interface JobFrontmatter {
  every?: ScheduleEvery
  /**
   * Path (relative to cwd) to a deterministic shell script that produces
   * the next-state fenced block on stdout. When present, the dispatcher
   * routes this slug to `duty-tick-scripted` (no agent) instead of the
   * default LLM-driven `duty-tick`. The script's stdout is the single
   * source of truth for the tick — must end with a `kody-job-next-state`
   * fenced JSON block.
   */
  tickScript?: string
  /**
   * When `true`, the scheduler skips this slug on every cron wake. Manual
   * triggers (workflow_dispatch via the dashboard "Run now" button) still
   * fire — disabling only blocks autonomous execution, not deliberate user
   * action. Absent or `false` keeps the job active.
   */
  disabled?: boolean
  /**
   * Slug of the staff member (persona) under `.kody/staff/<staff>.md` that
   * executes this duty. The duty owns the schedule; the staff member is
   * *who* the tick runs as — its persona body is injected ahead of the duty
   * body in `duty-tick`. A duty with no `staff:` is skipped by the scheduler
   * (every duty must name an executor). Many duties may share one staff
   * member; a duty has exactly one.
   */
  staff?: string
  /**
   * GitHub logins (stored WITHOUT a leading `@`) that this duty's output
   * should `@`-mention. Authored as a comma-separated list on one line —
   * `mentions: aguyaharonyair, alice`. The engine joins them into a
   * ready-to-insert `@a @b` string and exposes it to the duty prompt as the
   * `{{mentions}}` token, replacing ad-hoc `jq .github.operator` reads and
   * hardcoded handles. Absent or empty → undefined.
   */
  mentions?: string[]
  /**
   * Locked-toolbox mode (NEW). When set, the LLM agent receives ONLY these
   * tool names (plus `submit_state`) — `Bash`, `Read`, and `gh` are revoked.
   * The duty body becomes pure intent ("if behind, sync_pr"); the engine
   * exposes typed primitives via the `kody-duty` in-process MCP server.
   *
   * Authored as a comma-separated list on one line:
   *   `tools: list_prs_to_repair, sync_pr, fix_ci_pr, resolve_pr, recommend_to_operator, read_ledger`
   *
   * Absent → legacy Bash/gh mode (existing duties keep working). Present and
   * non-empty → locked mode: the LLM can only call duty-MCP tools by name.
   *
   * See `src/dutyMcp.ts` for the registered tool palette.
   */
  tools?: string[]
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function splitFrontmatter(raw: string): {
  frontmatter: JobFrontmatter
  body: string
} {
  const match = FRONTMATTER_RE.exec(raw)
  if (!match) return { frontmatter: {}, body: raw }
  const inner = match[1] ?? ""
  const body = raw.slice(match[0].length)
  return { frontmatter: parseFlatYaml(inner), body }
}

export function isScheduleEvery(value: unknown): value is ScheduleEvery {
  return typeof value === "string" && (SCHEDULE_EVERY_VALUES as readonly string[]).includes(value)
}

export function scheduleEveryToMs(every: ScheduleEvery): number {
  const MIN = 60 * 1000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  switch (every) {
    case "15m":
      return 15 * MIN
    case "30m":
      return 30 * MIN
    case "1h":
      return HOUR
    case "2h":
      return 2 * HOUR
    case "6h":
      return 6 * HOUR
    case "12h":
      return 12 * HOUR
    case "1d":
      return DAY
    case "3d":
      return 3 * DAY
    case "7d":
      return 7 * DAY
    case "manual":
      // Sentinel: never auto-fires. Returning Infinity is defensive — callers
      // (decideShouldFire) short-circuit before this branch is reached, but
      // if someone wires a new path that compares "elapsed >= interval"
      // they'll get a clean "never due" instead of a misleading 0.
      return Number.POSITIVE_INFINITY
  }
}

function parseFlatYaml(text: string): JobFrontmatter {
  const out: JobFrontmatter = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const colon = line.indexOf(":")
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    const value = stripQuotes(line.slice(colon + 1).trim())
    if (key === "every" && isScheduleEvery(value)) {
      out.every = value
    } else if (key === "tickScript" && value.length > 0) {
      out.tickScript = value
    } else if (key === "disabled") {
      const lower = value.toLowerCase()
      if (lower === "true") out.disabled = true
      else if (lower === "false") out.disabled = false
    } else if (key === "staff" && value.length > 0) {
      out.staff = value
    } else if (key === "mentions") {
      const logins = value
        .split(",")
        .map((s) => s.trim().replace(/^@/, ""))
        .filter(Boolean)
      if (logins.length > 0) out.mentions = logins
    } else if (key === "tools") {
      // Comma-separated list, same shape as `mentions:`. Names map to
      // mcp__kody-duty__<name> at agent-config time.
      const names = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      if (names.length > 0) out.tools = names
    }
  }
  return out
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}
