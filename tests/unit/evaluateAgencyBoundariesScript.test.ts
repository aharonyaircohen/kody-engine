import { describe, expect, it, vi } from "vitest"

import type { Context, Profile } from "../../src/executables/types.js"
import { evaluateAgencyBoundariesScript } from "../../src/scripts/evaluateAgencyBoundaries.js"

function fakeCtx(data: Record<string, unknown>): Context {
  return {
    args: {},
    cwd: "/repo",
    config: {},
    data,
    output: { exitCode: 0 },
  } as unknown as Context
}

function fakeProfile(capabilityKind: Profile["capabilityKind"]): Profile {
  return {
    name: "pr-health",
    capabilityKind,
  } as Profile
}

describe("evaluateAgencyBoundaries script", () => {
  it("stores a passing eval without failing the run", async () => {
    const ctx = fakeCtx({
      capabilityResults: [
        {
          version: 1,
          status: "pass",
          summary: "PR health observed.",
          facts: { ciGreen: true },
          artifacts: [],
          missingEvidence: [],
          blockers: [],
        },
      ],
    })
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await evaluateAgencyBoundariesScript(ctx, fakeProfile("observe"), null)

    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.data.agencyBoundaryEval).toMatchObject({ status: "pass", capability: "pr-health" })
    expect(write).toHaveBeenCalledWith(expect.stringContaining("KODY_AGENCY_BOUNDARY_EVAL="))
    write.mockRestore()
  })

  it("fails the run when an opted-in capability crosses a boundary", async () => {
    const ctx = fakeCtx({
      capabilityResults: [
        {
          version: 1,
          status: "changed",
          summary: "Opened a PR.",
          facts: { changedResources: [{ type: "pull-request", number: 123 }] },
          artifacts: [],
          missingEvidence: [],
          blockers: [],
        },
      ],
    })
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await evaluateAgencyBoundariesScript(ctx, fakeProfile("observe"), null)

    expect(ctx.output.exitCode).toBe(99)
    expect(ctx.output.reason).toContain("agency boundary eval failed")
    expect(ctx.data.agencyBoundaryEval).toMatchObject({ status: "fail" })
    write.mockRestore()
  })
})
