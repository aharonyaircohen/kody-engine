import { capabilityDeliveryTarget } from "./capabilityDelivery.js"

const SIMPLE_CAPABILITY_RUNTIME = "capability-run"

const DELIVERY_RUNTIMES = {
  "pull-request": "capability-delivery",
} as const

export interface SimpleCapabilityRuntime {
  implementation: string
  delivery?: keyof typeof DELIVERY_RUNTIMES
}

export function resolveSimpleCapabilityRuntime(
  implementation: string | undefined,
  delivery: keyof typeof DELIVERY_RUNTIMES | undefined,
): SimpleCapabilityRuntime | null {
  if (implementation !== SIMPLE_CAPABILITY_RUNTIME) return null
  return {
    implementation: delivery ? DELIVERY_RUNTIMES[delivery] : SIMPLE_CAPABILITY_RUNTIME,
    ...(delivery ? { delivery } : {}),
  }
}

export function simpleCapabilityRuntimeArgs(
  runtime: SimpleCapabilityRuntime,
  capability: string,
  input: unknown,
): Record<string, unknown> {
  const deliveryTarget = runtime.delivery ? capabilityDeliveryTarget(input) : null
  return {
    capability,
    ...(input !== undefined ? { input: JSON.stringify(input) } : {}),
    ...(deliveryTarget ? { [deliveryTarget.kind]: deliveryTarget.number } : {}),
  }
}
