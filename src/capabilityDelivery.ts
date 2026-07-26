export interface CapabilityDeliveryTarget {
  kind: "issue" | "pr"
  number: number
}

export function capabilityDeliveryTarget(input: unknown): CapabilityDeliveryTarget | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  const issue = positiveInteger(value.issue)
  const pr = positiveInteger(value.pr)
  if ((issue === null) === (pr === null)) return null
  return issue === null ? { kind: "pr", number: pr! } : { kind: "issue", number: issue }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}
