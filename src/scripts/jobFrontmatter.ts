/**
 * Tiny YAML-frontmatter parser/serializer for job files.
 *
 * Job markdown at `.kody/jobs/<slug>.md` may begin with a `---\n…\n---\n`
 * block carrying flat scalar key/value pairs (no nesting, no flow style).
 * Today the only recognized field is `every: 15m|30m|1h|6h|1d`, which
 * gates per-slug cadence in `dispatchJobFileTicks`. The parser silently
 * ignores unknown keys so the dashboard and engine can evolve the
 * frontmatter independently.
 *
 * Mirror of `src/dashboard/lib/jobs-frontmatter.ts` in Kody-Dashboard —
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
   * routes this slug to `job-tick-scripted` (no agent) instead of the
   * default LLM-driven `job-tick`. The script's stdout is the single
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
