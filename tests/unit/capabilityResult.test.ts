import { describe, expect, it } from "vitest"
import { CapabilityResultError, parseCapabilityResult } from "../../src/capabilityResult.js"

describe("parseCapabilityResult", () => {
  it("parses observe results with facts, alerts, and suggested actions", () => {
    expect(
      parseCapabilityResult(
        {
          kind: "observe",
          facts: { ciState: "failed" },
          alerts: [{ level: "warning", message: "CI failed." }],
          suggestedActions: [{ action: "fix-ci", args: { pr: 123 }, reason: "Tests failed." }],
        },
        "observe",
      ),
    ).toEqual({
      kind: "observe",
      facts: { ciState: "failed" },
      alerts: [{ level: "warning", message: "CI failed." }],
      suggestedActions: [{ action: "fix-ci", args: { pr: 123 }, reason: "Tests failed." }],
    })
  })

  it("rejects empty observe results", () => {
    expect(() => parseCapabilityResult({ kind: "observe" })).toThrow(CapabilityResultError)
  })

  it("parses act results with changed and created resources", () => {
    expect(
      parseCapabilityResult(
        {
          kind: "act",
          status: "created",
          createdResources: [{ type: "pr", number: 456, url: "https://github.com/a/b/pull/456" }],
          evidence: { releasePrExists: true },
        },
        "act",
      ),
    ).toEqual({
      kind: "act",
      status: "created",
      createdResources: [{ type: "pr", number: 456, url: "https://github.com/a/b/pull/456" }],
      evidence: { releasePrExists: true },
    })
  })

  it("rejects act results without a valid status", () => {
    expect(() => parseCapabilityResult({ kind: "act", status: "done" })).toThrow(CapabilityResultError)
  })

  it("parses verify results with pass/fail evidence", () => {
    expect(
      parseCapabilityResult(
        {
          kind: "verify",
          passed: false,
          evidence: [{ source: "preview", message: "Button missing." }],
          blockers: ["Preview does not satisfy acceptance check."],
        },
        "verify",
      ),
    ).toEqual({
      kind: "verify",
      passed: false,
      evidence: [{ source: "preview", message: "Button missing." }],
      blockers: ["Preview does not satisfy acceptance check."],
    })
  })

  it("rejects verify results without a boolean verdict", () => {
    expect(() => parseCapabilityResult({ kind: "verify", passed: "yes" })).toThrow(CapabilityResultError)
  })

  it("rejects kind mismatches against the declared capability kind", () => {
    expect(() => parseCapabilityResult({ kind: "act", status: "changed" }, "observe")).toThrow(/expected observe/)
  })

  it("accepts realistic observe output for release state discovery", () => {
    const result = parseCapabilityResult(
      {
        kind: "observe",
        facts: {
          currentVersion: "1.2.3",
          releasePr: null,
          ciState: "green",
        },
        suggestedActions: [{ action: "release-prepare", args: { issue: 123 } }],
      },
      "observe",
    )

    expect(result.kind).toBe("observe")
  })

  it("accepts realistic act output for release preparation", () => {
    const result = parseCapabilityResult(
      {
        kind: "act",
        status: "created",
        createdResources: [{ type: "pr", number: 456, url: "https://github.com/a/b/pull/456" }],
        evidence: { releasePrExists: true },
      },
      "act",
    )

    expect(result.kind).toBe("act")
  })

  it("accepts realistic verify output for release PR readiness", () => {
    const result = parseCapabilityResult(
      {
        kind: "verify",
        passed: true,
        evidence: [{ source: "checks", message: "All required checks passed." }],
        facts: { releasePrReady: true },
      },
      "verify",
    )

    expect(result.kind).toBe("verify")
  })
})
