import { describe, expect, it } from "vitest"
import type { Profile } from "../../src/executables/types.js"
import { summarizeFeedbackActions, verifyFixAlignment } from "../../src/scripts/verifyFixAlignment.js"

const fixProfile = { name: "fix" } as Profile
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

describe("verifyFixAlignment: summarizeFeedbackActions", () => {
  it("counts fixed and declined items", () => {
    const block = ["- Item 1: fixed: moved cache", "- Item 2: declined: out of scope"].join("\n")
    expect(summarizeFeedbackActions(block)).toEqual({
      totalItems: 2,
      fixedItems: 1,
      declinedItems: 1,
      unparsedLines: 0,
    })
  })

  it("counts lines that are neither fixed nor declined as unparsed", () => {
    const block = "- Item 1: ambiguous thing"
    expect(summarizeFeedbackActions(block)).toEqual({
      totalItems: 1,
      fixedItems: 0,
      declinedItems: 0,
      unparsedLines: 1,
    })
  })

  it("returns zeros for empty input", () => {
    expect(summarizeFeedbackActions("")).toEqual({
      totalItems: 0,
      fixedItems: 0,
      declinedItems: 0,
      unparsedLines: 0,
    })
  })
})

describe("verifyFixAlignment postflight", () => {
  it("is a no-op on non-fix profiles", async () => {
    const ctx = makeCtx({ agentDone: true, feedbackActions: "", commitResult: { committed: false } })
    await verifyFixAlignment(ctx as never, runProfile, null)
    expect(ctx.data.action).toBeUndefined()
    expect(ctx.output.exitCode).toBe(0)
  })

  it("is a no-op when agent did not finish (parseAgentResult already failed)", async () => {
    const ctx = makeCtx({ agentDone: false })
    await verifyFixAlignment(ctx as never, fixProfile, null)
    expect(ctx.data.action).toBeUndefined()
  })

  it("fails with FIX_FAILED when agent claims fixed items but no commit was made", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedbackActions: "- Item 1: fixed: moved cache",
      commitResult: { committed: false },
    })
    await verifyFixAlignment(ctx as never, fixProfile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect((ctx.data.action as { type: string } | undefined)?.type).toBe("FIX_FAILED")
    expect(String(ctx.output.reason)).toMatch(/1 fixed item/)
  })

  it("fails with FIX_FAILED when FEEDBACK_ACTIONS has zero items", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedbackActions: "some prose, no bullets",
      commitResult: { committed: true },
    })
    await verifyFixAlignment(ctx as never, fixProfile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect((ctx.data.action as { type: string } | undefined)?.type).toBe("FIX_FAILED")
  })

  it("emits FIX_DECLINED (not FAILED) when all items are declined and no commit was made", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedbackActions: "- Item 1: declined: wrong about code",
      commitResult: { committed: false },
    })
    await verifyFixAlignment(ctx as never, fixProfile, null)
    expect(ctx.data.agentDone).toBe(true)
    expect((ctx.data.action as { type: string } | undefined)?.type).toBe("FIX_DECLINED")
    expect(ctx.output.exitCode).toBe(0)
  })

  it("passes through when fixed items match a real commit", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedbackActions: "- Item 1: fixed: moved cache\n- Item 2: fixed: ilike regex",
      commitResult: { committed: true },
    })
    await verifyFixAlignment(ctx as never, fixProfile, null)
    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.action).toBeUndefined() // no override, upstream action stays
  })
})
