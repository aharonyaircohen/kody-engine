import type { LoopDefinition, LoopState } from "@kody-ade/agency-domain"

export type TriggerDecision =
  | { kind: "fire"; reason: string; scheduledAt: string; idempotencyKey: string }
  | { kind: "skip"; reason: string; nextEligibleAt?: string }

export function decideTrigger(input: {
  definition: LoopDefinition
  state: LoopState | null
  now: Date
  manualRequestId?: string
}): TriggerDecision {
  if (!input.state) return { kind: "skip", reason: "loop has no runtime state" }
  if (input.state.lifecycle !== "active") {
    return { kind: "skip", reason: `loop is ${input.state.lifecycle}` }
  }

  const trigger = input.definition.trigger
  if (trigger.type === "manual") {
    if (!input.manualRequestId?.trim()) return { kind: "skip", reason: "manual trigger was not requested" }
    return {
      kind: "fire",
      reason: "manual trigger was requested",
      scheduledAt: input.now.toISOString(),
      idempotencyKey: `${input.definition.id}:manual:${input.manualRequestId.trim()}`,
    }
  }

  if (trigger.type !== "schedule") {
    return { kind: "skip", reason: `${trigger.type} trigger is not enabled yet` }
  }

  const interval = parseInterval(trigger.every)
  const anchor = input.state.lastFiredAt ? Date.parse(input.state.lastFiredAt) : input.now.getTime() - interval
  const dueAt = anchor + interval
  if (input.now.getTime() < dueAt) {
    return { kind: "skip", reason: "scheduled trigger is not due", nextEligibleAt: new Date(dueAt).toISOString() }
  }

  const elapsedIntervals = Math.max(1, Math.floor((input.now.getTime() - anchor) / interval))
  const scheduledAt = new Date(anchor + elapsedIntervals * interval).toISOString()
  return {
    kind: "fire",
    reason: "scheduled trigger is due",
    scheduledAt,
    idempotencyKey: `${input.definition.id}:schedule:${scheduledAt}`,
  }
}

function parseInterval(value: string): number {
  const match = value.trim().match(/^(\d+)(m|h|d)$/)
  if (!match) throw new Error(`Unsupported schedule interval: ${value}`)
  const amount = Number(match[1])
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error(`Unsupported schedule interval: ${value}`)
  const unit = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000
  return amount * unit
}
