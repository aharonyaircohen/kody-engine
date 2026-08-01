/**
 * Build the stable environment contract shared by every trusted Capability
 * script runner. Inputs and Engine configuration remain separate namespaces:
 *
 * - KODY_ARG_* contains the current invocation input.
 * - KODY_CFG_* contains repository-owned Engine configuration.
 */
export function capabilityInputEnvironment(input: unknown): Record<string, string> {
  const environment: Record<string, string> = {
    KODY_CAPABILITY_INPUT: JSON.stringify(input ?? null),
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return environment
  }
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    const key = environmentKey(name)
    environment[`KODY_ARG_${key}`] = typeof value === "string" ? value : JSON.stringify(value)
  }
  return environment
}

export function capabilityConfigEnvironment(config: unknown): Record<string, string> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {}
  return Object.fromEntries(
    flattenConfig(config as Record<string, unknown>).map(([key, value]) => [`KODY_CFG_${key}`, value]),
  )
}

function flattenConfig(config: Record<string, unknown>, prefix = ""): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  for (const [name, value] of Object.entries(config)) {
    if (value === null || value === undefined) continue
    const key = prefix ? `${prefix}_${environmentKey(name)}` : environmentKey(name)
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      entries.push([key, String(value)])
    } else if (Array.isArray(value)) {
      entries.push([key, JSON.stringify(value)])
    } else if (typeof value === "object") {
      entries.push(...flattenConfig(value as Record<string, unknown>, key))
    }
  }
  return entries
}

function environmentKey(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
}
