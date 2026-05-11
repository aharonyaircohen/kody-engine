import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const querySpy = vi.fn()
let queryGenFactory: () => AsyncGenerator<unknown> = async function* () {
  yield { type: "result", subtype: "success", result: "DONE" }
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => {
    querySpy(args)
    return queryGenFactory()
  },
}))

import { runAgent } from "../../src/agent.js"

const baseOpts = {
  prompt: "hi",
  model: { provider: "minimax", model: "m" },
  cwd: process.cwd(),
  ndjsonDir: "/tmp/kody-outcome-test",
}

describe("runAgent: typed AgentOutcomeKind", () => {
  beforeEach(() => querySpy.mockClear())
  afterEach(() => {
    delete process.env.KODY_TURN_TIMEOUT_SEC
  })

  it("returns outcomeKind=ok on successful result", async () => {
    queryGenFactory = async function* () {
      yield { type: "result", subtype: "success", result: "DONE" }
    }
    const res = await runAgent(baseOpts)
    expect(res.outcome).toBe("completed")
    expect(res.outcomeKind).toBe("ok")
  })

  it("returns outcomeKind=out_of_turns when SDK signals max-turns error", async () => {
    queryGenFactory = async function* () {
      yield { type: "result", subtype: "error_max_turns", result: "" }
    }
    const res = await runAgent(baseOpts)
    expect(res.outcome).toBe("failed")
    expect(res.outcomeKind).toBe("out_of_turns")
  })

  it("returns outcomeKind=rate_limit when SDK signals rate-limit error", async () => {
    queryGenFactory = async function* () {
      yield { type: "result", subtype: "error_rate_limit", result: "" }
    }
    const res = await runAgent(baseOpts)
    expect(res.outcomeKind).toBe("rate_limit")
  })

  it("returns outcomeKind=tool_error for tool failures", async () => {
    queryGenFactory = async function* () {
      yield { type: "result", subtype: "tool_failed", result: "" }
    }
    const res = await runAgent(baseOpts)
    expect(res.outcomeKind).toBe("tool_error")
  })

  it("returns outcomeKind=model_error when the iterator throws", async () => {
    queryGenFactory = async function* () {
      throw new Error("network exploded")
      // biome-ignore lint/correctness/noUnreachable: needed to mark generator
      yield { type: "result", subtype: "success", result: "DONE" }
    }
    const res = await runAgent(baseOpts)
    expect(res.outcomeKind).toBe("model_error")
    expect(res.error).toMatch(/network exploded/)
  })

  it("returns outcomeKind=stalled when watchdog fires", async () => {
    queryGenFactory = async function* () {
      await new Promise((resolve) => setTimeout(resolve, 200))
      yield { type: "result", subtype: "success", result: "DONE" }
    }
    const res = await runAgent({ ...baseOpts, maxTurnTimeoutMs: 50 })
    expect(res.outcomeKind).toBe("stalled")
  })

  it("falls back to generic_failed for unknown subtypes", async () => {
    queryGenFactory = async function* () {
      yield { type: "result", subtype: "something_weird", result: "" }
    }
    const res = await runAgent(baseOpts)
    expect(res.outcomeKind).toBe("generic_failed")
  })
})
