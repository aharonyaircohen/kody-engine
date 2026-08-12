import { describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/implementations/types.js"
import { checkCoverageWithRetry } from "../../src/scripts/checkCoverageWithRetry.js"

describe("checkCoverageWithRetry", () => {
  it("defers repository-wide coverage policy for checkpoint delivery", async () => {
    const ctx = {
      cwd: process.cwd(),
      args: {},
      config: { git: { defaultBranch: "main" } },
      data: {
        capabilityDeliveryPolicy: "checkpoint",
        agentDone: true,
        coverageRules: [{ pattern: "src/*.ts", requireSibling: "tests/{name}.test.ts" }],
      },
      output: {},
    } as unknown as Context

    await checkCoverageWithRetry(ctx, {} as Profile, null)

    expect(ctx.data.coverageMisses).toEqual([])
    expect(ctx.data.verificationDeferred).toBe(true)
  })
})
