import { describe, expect, it } from "vitest"
import { completionToolCutoffAt, createCompletionToolGuard } from "../../src/completionGuard.js"

describe("agent completion guard", () => {
  it("reserves up to ten minutes of a long run for finishing", () => {
    expect(completionToolCutoffAt(0, 30 * 60_000)).toBe(20 * 60_000)
  })

  it("reserves one third of a shorter run for finishing", () => {
    expect(completionToolCutoffAt(0, 9 * 60_000)).toBe(6 * 60_000)
  })

  it("allows tools before the completion window", async () => {
    const guard = createCompletionToolGuard(10_000, () => 9_999)
    await expect(guard()).resolves.toEqual({})
  })

  it("blocks new tools during the completion window and tells the agent to finish", async () => {
    const guard = createCompletionToolGuard(10_000, () => 10_000)
    await expect(guard()).resolves.toMatchObject({
      decision: "block",
      reason: expect.stringMatching(/return your final response now/i),
    })
  })
})
