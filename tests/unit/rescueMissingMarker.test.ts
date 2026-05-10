import { describe, expect, it, vi } from "vitest"
import type { AgentResult } from "../../src/agent.js"
import { rescueMissingMarker } from "../../src/rescueMissingMarker.js"

function result(overrides: Partial<AgentResult> = {}): AgentResult {
  return { outcome: "completed", finalText: "", ...overrides }
}

describe("rescueMissingMarker", () => {
  it("returns the original result when DONE is present", async () => {
    const original = result({ finalText: "did the thing\nDONE\nCOMMIT_MSG: x" })
    const invoke = vi.fn()
    const out = await rescueMissingMarker(original, invoke)
    expect(out).toBe(original)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("returns the original result when COMMIT_MSG is present (DONE fallback)", async () => {
    const original = result({ finalText: "did stuff\nCOMMIT_MSG: feat: thing" })
    const invoke = vi.fn()
    const out = await rescueMissingMarker(original, invoke)
    expect(out).toBe(original)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("returns the original result when FAILED: is present", async () => {
    const original = result({ finalText: "could not do it\nFAILED: oom" })
    const invoke = vi.fn()
    const out = await rescueMissingMarker(original, invoke)
    expect(out).toBe(original)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("does not re-prompt when the SDK reported failure", async () => {
    const original = result({ outcome: "failed", finalText: "no marker here", error: "5xx" })
    const invoke = vi.fn()
    const out = await rescueMissingMarker(original, invoke)
    expect(out).toBe(original)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("re-prompts once when marker is missing and appends the rescue text", async () => {
    const original = result({ finalText: "## Final state\n- typecheck ✅\n- tests ✅" })
    const invoke = vi.fn().mockResolvedValueOnce(result({ finalText: "DONE\nCOMMIT_MSG: feat: x" }))
    const out = await rescueMissingMarker(original, invoke)
    expect(invoke).toHaveBeenCalledOnce()
    expect(out.finalText).toContain("## Final state")
    expect(out.finalText).toContain("DONE")
    expect(out.finalText).toContain("COMMIT_MSG: feat: x")
    expect(out.outcome).toBe("completed")
  })

  it("keeps the original outcome when the rescue invocation itself fails", async () => {
    const original = result({ finalText: "no marker" })
    const invoke = vi.fn().mockResolvedValueOnce(result({ outcome: "failed", finalText: "boom", error: "x" }))
    const out = await rescueMissingMarker(original, invoke)
    expect(out.outcome).toBe("completed")
    expect(out.finalText).toContain("no marker")
    expect(out.finalText).toContain("boom")
  })

  it("returns the original result if the rescue invocation throws", async () => {
    const original = result({ finalText: "no marker" })
    const invoke = vi.fn().mockRejectedValueOnce(new Error("network down"))
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const out = await rescueMissingMarker(original, invoke)
    expect(out).toBe(original)
    expect(stderr).toHaveBeenCalled()
    stderr.mockRestore()
  })

  it("returns the original result if the rescue produces empty text", async () => {
    const original = result({ finalText: "no marker" })
    const invoke = vi.fn().mockResolvedValueOnce(result({ finalText: "   " }))
    const out = await rescueMissingMarker(original, invoke)
    expect(out).toBe(original)
  })
})
