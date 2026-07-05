export type GoalEvidenceResultClass = "succeeded" | "pending" | "retryable" | "needsFix" | "fatal"

export interface GoalEvidenceProgress {
  resultClass: GoalEvidenceResultClass
  attempts: number
  reason?: string
  nextAction?: string
  nextRetryAt?: string
  issue?: number
  updatedAt?: string
}

export type GoalEvidenceState = Record<string, GoalEvidenceProgress>

export function parseGoalEvidenceState(raw: unknown): GoalEvidenceState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: GoalEvidenceState = {}
  for (const [evidence, value] of Object.entries(raw as Record<string, unknown>)) {
    const progress = parseGoalEvidenceProgress(value)
    if (progress) out[evidence] = progress
  }
  return out
}

export function mergeGoalEvidenceProgress(
  state: GoalEvidenceState,
  evidence: string,
  update: Partial<GoalEvidenceProgress> & { resultClass: GoalEvidenceResultClass },
): GoalEvidenceState {
  const prior = state[evidence]
  const next: GoalEvidenceProgress = {
    resultClass: update.resultClass,
    attempts: update.attempts ?? prior?.attempts ?? 0,
    ...(prior?.reason ? { reason: prior.reason } : {}),
    ...(prior?.nextAction ? { nextAction: prior.nextAction } : {}),
    ...(prior?.nextRetryAt ? { nextRetryAt: prior.nextRetryAt } : {}),
    ...(prior?.issue ? { issue: prior.issue } : {}),
    ...(prior?.updatedAt ? { updatedAt: prior.updatedAt } : {}),
    ...definedProgressFields(update),
  }

  return {
    ...state,
    [evidence]: next,
  }
}

export function isGoalEvidenceResultClass(value: unknown): value is GoalEvidenceResultClass {
  return (
    value === "succeeded" ||
    value === "pending" ||
    value === "retryable" ||
    value === "needsFix" ||
    value === "fatal"
  )
}

function parseGoalEvidenceProgress(value: unknown): GoalEvidenceProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!isGoalEvidenceResultClass(raw.resultClass)) return null
  const attempts = typeof raw.attempts === "number" && raw.attempts >= 0 ? Math.floor(raw.attempts) : 0
  return {
    resultClass: raw.resultClass,
    attempts,
    ...(stringField(raw.reason) ? { reason: stringField(raw.reason) } : {}),
    ...(stringField(raw.nextAction) ? { nextAction: stringField(raw.nextAction) } : {}),
    ...(stringField(raw.nextRetryAt) ? { nextRetryAt: stringField(raw.nextRetryAt) } : {}),
    ...(positiveInteger(raw.issue) ? { issue: positiveInteger(raw.issue) } : {}),
    ...(stringField(raw.updatedAt) ? { updatedAt: stringField(raw.updatedAt) } : {}),
  }
}

function definedProgressFields(update: Partial<GoalEvidenceProgress>): Partial<GoalEvidenceProgress> {
  const out: Partial<GoalEvidenceProgress> = {}
  if (update.reason !== undefined) out.reason = update.reason
  if (update.nextAction !== undefined) out.nextAction = update.nextAction
  if (update.nextRetryAt !== undefined) out.nextRetryAt = update.nextRetryAt
  if (update.issue !== undefined) out.issue = update.issue
  if (update.updatedAt !== undefined) out.updatedAt = update.updatedAt
  return out
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  return undefined
}
