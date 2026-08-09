import { describe, expect, it, vi } from "vitest"

vi.mock("../../src/scripts/runFlow.js", () => ({ runFlow: vi.fn() }))
vi.mock("../../src/scripts/syncFlow.js", () => ({ syncFlow: vi.fn() }))
vi.mock("../../src/branch.js", () => ({ checkoutPrBranch: vi.fn() }))

import type { Context, Profile } from "../../src/implementations/types.js"
import { checkoutPrBranch } from "../../src/branch.js"
import { prepareCapabilityDelivery } from "../../src/scripts/prepareCapabilityDelivery.js"
import { runFlow } from "../../src/scripts/runFlow.js"
import { syncFlow } from "../../src/scripts/syncFlow.js"

const profile = {} as Profile

function makeCtx(input: Record<string, unknown>): Context {
  return {
    args: {},
    cwd: "/tmp/repo",
    config: {} as Context["config"],
    data: { capabilityInput: input },
    output: { exitCode: 0 },
  } as Context
}

describe("prepareCapabilityDelivery", () => {
  it("checks out an existing PR without merging its base branch", async () => {
    const ctx = makeCtx({ pr: 19 })

    await prepareCapabilityDelivery(ctx, profile)

    expect(ctx.args.pr).toBe(19)
    expect(checkoutPrBranch).toHaveBeenCalledWith(19, "/tmp/repo")
    expect(ctx.data.commentTargetType).toBe("pr")
    expect(ctx.data.commentTargetNumber).toBe(19)
    expect(syncFlow).not.toHaveBeenCalled()
    expect(runFlow).not.toHaveBeenCalled()
  })

  it("keeps issue delivery on the issue-to-PR flow", async () => {
    const ctx = makeCtx({ issue: 42 })

    await prepareCapabilityDelivery(ctx, profile)

    expect(ctx.args.issue).toBe(42)
    expect(runFlow).toHaveBeenCalledWith(ctx, profile)
  })
})
