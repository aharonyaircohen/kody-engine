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

  it("unwraps generic input when the implementation also declares routing inputs", () => {
    expect(
      capabilityContractInput(
        [{ name: "input" }, { name: "base" }],
        { input: '{"issue":42}', base: "main" },
      ),
    ).toEqual({ issue: 42 })
  })

  it("uses empty business input for a parameterless generic runner invocation", () => {
    expect(
      capabilityContractInput(
        [{ name: "input" }],
        { capability: "inspect" },
        "inspect",
      ),
    ).toEqual({})
  })

  it("keeps capability when the business contract explicitly declares it", () => {
    const args = { capability: "business-value" }
    expect(
      capabilityContractInput([], args, "runner", ["capability"]),
    ).toBe(args)
  })

  it("keeps ordinary named capability inputs unchanged", () => {
    const args = { issue: 42 }
    expect(
      capabilityContractInput([{ name: "issue" }], args),
    ).toBe(args)
  })
})
