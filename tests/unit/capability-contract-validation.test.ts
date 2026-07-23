import { describe, expect, it } from "vitest"
import {
  CapabilityContractValidationError,
  validateCapabilityContractValue,
} from "../../src/agency/capability-contract-validation.js"

describe("Capability contract validation", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      issue: { type: "integer" },
    },
    required: ["issue"],
  }

  it("accepts canonical values that match the contract", () => {
    expect(() => validateCapabilityContractValue("input", schema, { issue: 42 })).not.toThrow()
  })

  it("rejects invalid canonical input with a boundary-specific error", () => {
    expect(() => validateCapabilityContractValue("input", schema, { issue: "42" })).toThrow(
      CapabilityContractValidationError,
    )
  })

  it("validates output through the same portable contract boundary", () => {
    expect(() => validateCapabilityContractValue("output", schema, {})).toThrow(/Capability output/)
  })
})
