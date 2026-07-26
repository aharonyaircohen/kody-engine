import { describe, expect, it } from "vitest"
import { capabilityDeliveryTarget } from "../../src/capabilityDelivery.js"

describe("capability delivery target", () => {
  it.each([
    [{ issue: 7 }, { kind: "issue", number: 7 }],
    [{ pr: 42 }, { kind: "pr", number: 42 }],
  ] as const)("reads a supported target from capability input", (input, expected) => {
    expect(capabilityDeliveryTarget(input)).toEqual(expected)
  })

  it.each([
    undefined,
    null,
    {},
    { issue: "7" },
    { pr: 0 },
    { issue: 7, pr: 42 },
  ])("rejects missing or ambiguous delivery input", (input) => {
    expect(capabilityDeliveryTarget(input)).toBeNull()
  })
})
