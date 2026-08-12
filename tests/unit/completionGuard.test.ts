import { describe, expect, it } from "vitest"
import { completionToolCutoffAt, createCompletionToolGuard } from "../../src/completionGuard.js"

describe("agent completion guard", () => {
  it("reserves up to fifteen minutes of a long run for finishing and deterministic postflights", () => {
    expect(completionToolCutoffAt(0, 30 * 60_000)).toBe(15 * 60_000)
  })

  it("reserves half of a shorter run for finishing", () => {
    expect(completionToolCutoffAt(0, 9 * 60_000)).toBe(4.5 * 60_000)
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

  it("still allows the one required structured-result write", async () => {
    const guard = createCompletionToolGuard(10_000, () => 10_000, "/tmp/result.json")
    await expect(guard({ tool_name: "Write", tool_input: { file_path: "/tmp/result.json" } })).resolves.toEqual({})
    await expect(guard({ tool_name: "Write", tool_input: { file_path: "/tmp/other.json" } })).resolves.toMatchObject({
      decision: "block",
    })
  })
})
