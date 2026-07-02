import { describe, expect, it } from "vitest"

import { evaluateAgencyBoundaries } from "../../src/agencyBoundaryEval.js"
import type { CapabilityResult } from "../../src/capabilityResult.js"

function result(overrides: Partial<CapabilityResult> = {}): CapabilityResult {
  return {
    version: 1,
    status: "pass",
    summary: "CI is green.",
    facts: {},
    artifacts: [],
    missingEvidence: [],
    blockers: [],
    ...overrides,
  }
}

describe("agency boundary eval", () => {
  it("passes when observe reports facts without action output", () => {
    const actual = evaluateAgencyBoundaries({
      capability: "pr-health",
      capabilityKind: "observe",
      results: [result({ facts: { ciGreen: true } })],
    })

    expect(actual.status).toBe("pass")
    expect(actual.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "observe-does-not-act",
          status: "pass",
        }),
      ]),
    )
  })

  it("fails when observe returns action-shaped output", () => {
    const actual = evaluateAgencyBoundaries({
      capability: "pr-health",
      capabilityKind: "observe",
      results: [result({ status: "changed", facts: { changedResources: [{ type: "pr", number: 123 }] } })],
    })

    expect(actual.status).toBe("fail")
    expect(actual.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "observe-does-not-act",
          status: "fail",
        }),
      ]),
    )
  })

  it("fails when verify returns fix-shaped output", () => {
    const actual = evaluateAgencyBoundaries({
      capability: "ui-review",
      capabilityKind: "verify",
      results: [result({ facts: { actionResult: { fixed: true } } })],
    })

    expect(actual.status).toBe("fail")
    expect(actual.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "verify-does-not-fix",
          status: "fail",
        }),
      ]),
    )
  })

  it("fails when capability output names a parent goal target", () => {
    const actual = evaluateAgencyBoundaries({
      capability: "release-prepare",
      capabilityKind: "act",
      results: [result({ target: { type: "goal", id: "web-release" } })],
    })

    expect(actual.status).toBe("fail")
    expect(actual.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "capability-does-not-own-goal-progress",
          status: "fail",
        }),
      ]),
    )
  })
})
