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
   * Sentinel: the scheduler never auto-fires this duty. Only manual triggers
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
      return Number.POSITIVE_INFINITY
  }
}
