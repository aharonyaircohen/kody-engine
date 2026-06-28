export interface DeliveryOutcome {
  kind: "not_required"
  reason: string
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

export function setDeliveryNotRequired(data: Record<string, unknown>, reason: string): void {
  data.deliveryOutcome = { kind: "not_required", reason }
}

export function readDeliveryOutcome(data: Record<string, unknown>): DeliveryOutcome | null {
  const raw = data.deliveryOutcome
  if (!isRecord(raw)) return null
  if (raw.kind !== "not_required" || typeof raw.reason !== "string" || raw.reason.length === 0) return null
  return { kind: "not_required", reason: raw.reason }
}

export function isDeliveryNotRequired(data: Record<string, unknown>): boolean {
  return readDeliveryOutcome(data)?.kind === "not_required"
}
