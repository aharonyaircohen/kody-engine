import { describe, expect, it } from "vitest"
import {
  CapabilityContractValidationError,
  capabilityContractInput,
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

  it("unwraps and parses the generic runner input before contract validation", () => {
    expect(
      capabilityContractInput(
        [{ name: "capability" }, { name: "input" }],
        { capability: "inspect", input: '{"issue":42}' },
      ),
    ).toEqual({ issue: 42 })
  })

  it("unwraps the single generic input used by hydrated Store capabilities", () => {
    expect(
      capabilityContractInput(
        [{ name: "input" }],
        { input: '{"issue":42}' },
      ),
    ).toEqual({ issue: 42 })
  })

  it("keeps ordinary named capability inputs unchanged", () => {
    const args = { issue: 42 }
    expect(
      capabilityContractInput([{ name: "issue" }], args),
    ).toBe(args)
  })
})
