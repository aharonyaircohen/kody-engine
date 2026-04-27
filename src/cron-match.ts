/**
 * Minimal 5-field cron matcher.
 *
 * Supports: `*`, lists (`1,5,15`), ranges (`9-17`), steps (`*​/5`,
 * `0-30/5`). Five fields: minute hour day-of-month month day-of-week.
 * Day-of-week: 0–6, Sunday=0. All evaluation is in UTC because GitHub
 * Actions schedule events fire on UTC.
 *
 * No external dependency — keeps the engine small.
 */

interface CronExpr {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
}

const FIELD_BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day-of-month
  [1, 12], // month
  [0, 6], // day-of-week
]

export function parseCron(spec: string): CronExpr {
  const fields = spec.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: "${spec}" — expected 5 space-separated fields`)
  }
  const sets = fields.map((f, i) => parseField(f, FIELD_BOUNDS[i]![0], FIELD_BOUNDS[i]![1]))
  return { minute: sets[0]!, hour: sets[1]!, dom: sets[2]!, month: sets[3]!, dow: sets[4]! }
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const part of field.split(",")) {
    const [base, stepStr] = part.split("/")
    const step = stepStr ? parseInt(stepStr, 10) : 1
    if (!Number.isFinite(step) || step < 1) {
      throw new Error(`Invalid step in cron field "${field}"`)
    }
    let lo: number
    let hi: number
    if (base === "*") {
      lo = min
      hi = max
    } else if (base!.includes("-")) {
      const [aStr, bStr] = base!.split("-")
      lo = parseInt(aStr!, 10)
      hi = parseInt(bStr!, 10)
    } else {
      lo = parseInt(base!, 10)
      hi = lo
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Invalid cron field "${field}" — out of range [${min},${max}] or reversed`)
    }
    for (let i = lo; i <= hi; i += step) out.add(i)
  }
  return out
}

export function cronMatchesAt(expr: CronExpr, date: Date): boolean {
  return (
    expr.minute.has(date.getUTCMinutes()) &&
    expr.hour.has(date.getUTCHours()) &&
    expr.dom.has(date.getUTCDate()) &&
    expr.month.has(date.getUTCMonth() + 1) &&
    expr.dow.has(date.getUTCDay())
  )
}

/**
 * True iff `spec` would have fired any minute in the half-open window
 * `(end - windowSec, end]` (UTC). Used to absorb GitHub Actions cron drift:
 * a daily `0 2 * * *` watch should still fire when the wake itself arrives
 * a few minutes after 02:00.
 */
export function cronMatchesInWindow(spec: string, end: Date, windowSec: number): boolean {
  const expr = parseCron(spec)
  const endMs = Math.floor(end.getTime() / 60_000) * 60_000 // floor to minute
  const minuteSteps = Math.max(1, Math.ceil(windowSec / 60))
  for (let i = 0; i < minuteSteps; i++) {
    if (cronMatchesAt(expr, new Date(endMs - i * 60_000))) return true
  }
  return false
}
