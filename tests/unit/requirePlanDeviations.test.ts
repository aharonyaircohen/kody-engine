import { describe, expect, it } from "vitest"
import type { Profile } from "../../src/executables/types.js"
import { isNoneSentinel, requirePlanDeviations } from "../../src/scripts/requirePlanDeviations.js"

const runProfile = { name: "run" } as Profile

function makeCtx(data: Record<string, unknown>) {
  return {
    args: {},
    cwd: "/x",
    config: {} as never,
    data,
    output: { exitCode: 0 } as { exitCode: number; reason?: string; prUrl?: string },
    skipAgent: false,
  }
}

describe("requirePlanDeviations: isNoneSentinel", () => {
  it("accepts '- none'", () => {
    expect(isNoneSentinel("- none")).toBe(true)
  })
  it("accepts 'none' without bullet", () => {
    expect(isNoneSentinel("none")).toBe(true)
  })
  it("is case-insensitive", () => {
    expect(isNoneSentinel("- None")).toBe(true)
  })
  it("rejects multiple items", () => {
    expect(isNoneSentinel("- none\n- something")).toBe(false)
  })
  it("rejects prose", () => {
    expect(isNoneSentinel("no deviations at all")).toBe(false)
  })
})

describe("requirePlanDeviations postflight", () => {
  it("is a no-op when agent did not finish", async () => {
    const ctx = makeCtx({ agentDone: false })
    await requirePlanDeviations(ctx as never, runProfile, null)
    expect(ctx.data.action).toBeUndefined()
  })

  it("is a no-op when no plan artifact was loaded", async () => {
    const ctx = makeCtx({ agentDone: true, artifacts: {}, planDeviations: "" })
    await requirePlanDeviations(ctx as never, runProfile, null)
    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.action).toBeUndefined()
  })

  it("flips DONE to FAILED when plan was provided but PLAN_DEVIATIONS is missing", async () => {
    const ctx = makeCtx({ agentDone: true, artifacts: { plan: "## Do X" }, planDeviations: "" })
    await requirePlanDeviations(ctx as never, runProfile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect((ctx.data.action as { type: string } | undefined)?.type).toBe("RUN_FAILED")
    expect(String(ctx.data.agentFailureReason)).toMatch(/omitted required PLAN_DEVIATIONS/)
  })

  it("passes when plan was provided and PLAN_DEVIATIONS is 'none'", async () => {
    const ctx = makeCtx({
      agentDone: true,
      artifacts: { plan: "## Do X" },
      planDeviations: "- none",
    })
    await requirePlanDeviations(ctx as never, runProfile, null)
    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.action).toBeUndefined()
  })

  it("passes when PLAN_DEVIATIONS lists bullet items", async () => {
    const ctx = makeCtx({
      agentDone: true,
      artifacts: { plan: "## Do X" },
      planDeviations: "- Plan said foo.ts → used bar.ts (reason: existing file)",
    })
    await requirePlanDeviations(ctx as never, runProfile, null)
    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.planDeviationCount).toBe(1)
  })

  it("fails when PLAN_DEVIATIONS is prose without bullets or 'none'", async () => {
    const ctx = makeCtx({
      agentDone: true,
      artifacts: { plan: "## Do X" },
      planDeviations: "I followed the plan basically",
    })
    await requirePlanDeviations(ctx as never, runProfile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect((ctx.data.action as { type: string } | undefined)?.type).toBe("RUN_FAILED")
  })
})
