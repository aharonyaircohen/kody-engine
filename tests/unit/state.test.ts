import { describe, expect, it } from "vitest"
import {
  type Action,
  emptyState,
  parseStateComment,
  reduce,
  renderStateComment,
  STATE_BEGIN,
  STATE_END,
} from "../../src/state.js"

describe("state: emptyState", () => {
  it("has the expected initial shape", () => {
    const s = emptyState()
    expect(s.schemaVersion).toBe(1)
    expect(s.core.phase).toBe("idle")
    expect(s.core.status).toBe("pending")
    expect(s.core.currentExecutable).toBeNull()
    expect(s.core.lastOutcome).toBeNull()
    expect(s.core.attempts).toEqual({})
    expect(s.executables).toEqual({})
    expect(s.history).toEqual([])
  })
})

describe("state: reduce", () => {
  const ok: Action = { type: "RUN_COMPLETED", payload: { prUrl: "u" }, timestamp: "2026-04-20T09:00:00Z" }
  const fail: Action = { type: "RUN_FAILED", payload: { reason: "boom" }, timestamp: "2026-04-20T09:05:00Z" }

  it("increments attempts for the executable", () => {
    const s1 = reduce(emptyState(), "build", ok)
    expect(s1.core.attempts).toEqual({ build: 1 })
    const s2 = reduce(s1, "build", fail)
    expect(s2.core.attempts).toEqual({ build: 2 })
  })

  it("records the latest action as lastOutcome and per-executable lastAction", () => {
    const s = reduce(emptyState(), "build", ok)
    expect(s.core.lastOutcome).toEqual(ok)
    expect(s.executables.build?.lastAction).toEqual(ok)
  })

  it("derives status=succeeded from *_COMPLETED", () => {
    expect(reduce(emptyState(), "build", ok).core.status).toBe("succeeded")
  })

  it("derives status=failed from *_FAILED", () => {
    expect(reduce(emptyState(), "build", fail).core.status).toBe("failed")
  })

  it("appends to history (capped at 20)", () => {
    let s = emptyState()
    for (let i = 0; i < 25; i++) {
      s = reduce(s, "build", { type: "RUN_COMPLETED", payload: {}, timestamp: `t${i}` })
    }
    expect(s.history.length).toBe(20)
    expect(s.history.at(-1)!.timestamp).toBe("t24")
    expect(s.history[0]!.timestamp).toBe("t5")
  })

  it("is a no-op when action is null", () => {
    const s = emptyState()
    expect(reduce(s, "build", null)).toBe(s)
  })
})

describe("state: parseStateComment / renderStateComment", () => {
  it("round-trips a non-empty state", () => {
    const s1 = reduce(emptyState(), "build", {
      type: "RUN_COMPLETED",
      payload: { prUrl: "https://github.com/x/y/pull/1" },
      timestamp: "2026-04-20T09:00:00Z",
    })
    const body = renderStateComment(s1)
    expect(body).toContain(STATE_BEGIN)
    expect(body).toContain(STATE_END)
    expect(body).toContain("```json")
    const s2 = parseStateComment(body)
    expect(s2.core.lastOutcome?.type).toBe("RUN_COMPLETED")
    expect(s2.core.attempts.build).toBe(1)
  })

  it("returns empty state when sentinels are missing", () => {
    const s = parseStateComment("some random text without markers")
    expect(s).toEqual(emptyState())
  })

  it("returns empty state when JSON is malformed", () => {
    const body = `${STATE_BEGIN}\n\n\`\`\`json\n{not valid\n\`\`\`\n${STATE_END}`
    expect(parseStateComment(body)).toEqual(emptyState())
  })

  it("renders a human section with attempts + PR URL", () => {
    const s = reduce(emptyState(), "build", {
      type: "RUN_COMPLETED",
      payload: { prUrl: "https://ex/pull/42" },
      timestamp: "t",
    })
    s.core.prUrl = "https://ex/pull/42"
    const body = renderStateComment(s)
    expect(body).toMatch(/## kody2 task state/)
    expect(body).toMatch(/\*\*Attempts:\*\* build:1/)
    expect(body).toMatch(/\*\*PR:\*\* https:\/\/ex\/pull\/42/)
  })
})
