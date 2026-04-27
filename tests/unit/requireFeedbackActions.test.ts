import { describe, expect, it } from "vitest"
import type { Profile } from "../../src/executables/types.js"
import { countActionItems, requireFeedbackActions } from "../../src/scripts/requireFeedbackActions.js"

const profile = { name: "fix" } as Profile

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

describe("requireFeedbackActions: countActionItems", () => {
  it("counts dash-prefixed lines", () => {
    expect(countActionItems(["- Item 1: fixed", "- Item 2: declined: …", "- Item 3: fixed"].join("\n"))).toBe(3)
  })
  it("counts asterisk-prefixed lines", () => {
    expect(countActionItems("* Item 1\n* Item 2")).toBe(2)
  })
  it("ignores non-bullet lines", () => {
    expect(countActionItems("prose here\n- one item\nmore prose")).toBe(1)
  })
  it("returns 0 for empty input", () => {
    expect(countActionItems("")).toBe(0)
    expect(countActionItems("   \n  \n")).toBe(0)
  })
})

describe("requireFeedbackActions postflight", () => {
  it("is a no-op when agent did not complete", async () => {
    const ctx = makeCtx({ agentDone: false })
    await requireFeedbackActions(ctx as never, profile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect(ctx.data.action).toBeUndefined()
  })

  it("accepts DONE with non-empty FEEDBACK_ACTIONS", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedbackActions: "- Item 1: fixed: moved cache",
      action: { type: "FIX_COMPLETED", payload: {}, timestamp: "" },
    })
    await requireFeedbackActions(ctx as never, profile, null)
    expect(ctx.data.agentDone).toBe(true)
    expect((ctx.data.action as { type: string }).type).toBe("FIX_COMPLETED")
  })

  it("fails when FEEDBACK_ACTIONS is empty", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedbackActions: "",
      action: { type: "FIX_COMPLETED", payload: {}, timestamp: "" },
    })
    await requireFeedbackActions(ctx as never, profile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect((ctx.data.action as { type: string }).type).toBe("FIX_FAILED")
    expect(String(ctx.data.agentFailureReason)).toMatch(/omitted required FEEDBACK_ACTIONS/)
  })

  it("fails when FEEDBACK_ACTIONS has no bullet items", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedbackActions: "I handled everything.",
      action: { type: "FIX_COMPLETED", payload: {}, timestamp: "" },
    })
    await requireFeedbackActions(ctx as never, profile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect((ctx.data.action as { type: string }).type).toBe("FIX_FAILED")
    expect(String(ctx.data.agentFailureReason)).toMatch(/listed no items/)
  })

  it("accepts DONE with fewer items than review has bullets (parity check dropped)", async () => {
    const review = [
      "### Concerns",
      "- concern A at `src/foo.ts:10`",
      "- concern B at `src/foo.ts:20`",
      "- concern C at `src/bar.ts:5`",
      "### Suggestions",
      "- fix for A",
      "- fix for B",
      "- fix for C",
    ].join("\n")
    const ctx = makeCtx({
      agentDone: true,
      feedback: review,
      feedbackActions: "- Item 1: fixed: addressed A+B\n- Item 2: fixed: addressed C",
      action: { type: "FIX_COMPLETED", payload: {}, timestamp: "" },
    })
    await requireFeedbackActions(ctx as never, profile, null)
    expect(ctx.data.agentDone).toBe(true)
    expect((ctx.data.action as { type: string }).type).toBe("FIX_COMPLETED")
  })
})
