import { describe, expect, it } from "vitest"
import type { Profile } from "../../src/executables/types.js"
import {
  countActionableReviewBullets,
  countActionItems,
  requireFeedbackActions,
} from "../../src/scripts/requireFeedbackActions.js"

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
    expect(
      countActionItems(["- Item 1: fixed", "- Item 2: declined: …", "- Item 3: fixed"].join("\n")),
    ).toBe(3)
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

  it("returns 0 for prose-only block", () => {
    expect(countActionItems("I addressed the feedback.")).toBe(0)
  })
})

describe("requireFeedbackActions postflight", () => {
  it("is a no-op when agent did not complete", async () => {
    const ctx = makeCtx({ agentDone: false })
    await requireFeedbackActions(ctx as never, profile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect(ctx.data.action).toBeUndefined()
  })

  it("accepts DONE with well-formed FEEDBACK_ACTIONS", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedbackActions: "- Item 1: fixed: moved cache\n- Item 2: fixed: added regex",
      action: { type: "FIX_COMPLETED", payload: {}, timestamp: "" },
    })
    await requireFeedbackActions(ctx as never, profile, null)
    expect(ctx.data.agentDone).toBe(true)
    expect((ctx.data.action as { type: string }).type).toBe("FIX_COMPLETED")
  })

  it("flips DONE to FAILED when FEEDBACK_ACTIONS is empty", async () => {
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

  it("flips DONE to FAILED when FEEDBACK_ACTIONS has no bullet items", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedbackActions: "I handled everything in the feedback.",
      action: { type: "FIX_COMPLETED", payload: {}, timestamp: "" },
    })
    await requireFeedbackActions(ctx as never, profile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect((ctx.data.action as { type: string }).type).toBe("FIX_FAILED")
    expect(String(ctx.data.agentFailureReason)).toMatch(/listed no items/)
  })

  it("flips DONE to FAILED when FEEDBACK_ACTIONS has fewer items than the review's Concerns+Suggestions", async () => {
    const review = [
      "## Verdict: CONCERNS",
      "",
      "### Concerns",
      "- Cache is per-request — provides no real caching benefit.",
      "- MongoDB `like` is case-sensitive.",
      "",
      "### Suggestions",
      "- Unused `WhereField` import.",
      "",
      "### Strengths",
      "- Solid tests.",
    ].join("\n")
    const ctx = makeCtx({
      agentDone: true,
      feedback: review,
      feedbackActions: "- Item 1: fixed: tightened difficulty guard",
      action: { type: "FIX_COMPLETED", payload: {}, timestamp: "" },
    })
    await requireFeedbackActions(ctx as never, profile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect((ctx.data.action as { type: string }).type).toBe("FIX_FAILED")
    expect(String(ctx.data.agentFailureReason)).toMatch(/3 actionable bullet/)
  })

  it("passes when FEEDBACK_ACTIONS count matches review actionable count", async () => {
    const review = "## Verdict: CONCERNS\n\n### Concerns\n- A\n- B\n\n### Strengths\n- X\n"
    const ctx = makeCtx({
      agentDone: true,
      feedback: review,
      feedbackActions: "- Item 1: fixed: A\n- Item 2: declined: B",
      action: { type: "FIX_COMPLETED", payload: {}, timestamp: "" },
    })
    await requireFeedbackActions(ctx as never, profile, null)
    expect(ctx.data.agentDone).toBe(true)
    expect((ctx.data.action as { type: string }).type).toBe("FIX_COMPLETED")
  })
})

describe("requireFeedbackActions: countActionableReviewBullets", () => {
  it("counts bullets only under Concerns/Suggestions/Bugs", () => {
    const body = [
      "## Verdict: CONCERNS",
      "### Strengths",
      "- strength A",
      "### Concerns",
      "- concern A",
      "- concern B",
      "### Summary",
      "- summary A",
      "### Suggestions",
      "- suggestion A",
      "### Bugs",
      "- bug A",
    ].join("\n")
    expect(countActionableReviewBullets(body)).toBe(4)
  })

  it("returns 0 when no actionable headings are present", () => {
    expect(countActionableReviewBullets("## Verdict: PASS\n\n### Strengths\n- S")).toBe(0)
  })

  it("returns 0 for empty body", () => {
    expect(countActionableReviewBullets("")).toBe(0)
  })

  it("ignores sub-bullets (indented)", () => {
    const body = "### Concerns\n- top-level\n  - sub-bullet\n- another top-level"
    expect(countActionableReviewBullets(body)).toBe(2)
  })
})
