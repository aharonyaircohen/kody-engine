import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const querySpy = vi.fn()
let queryGenFactory: () => AsyncGenerator<unknown> = async function* () {
  yield { type: "result", subtype: "success", result: "ok" }
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
  ndjsonDir: "/tmp/kody-agent-timeout-test",
}

describe("runAgent: per-turn watchdog", () => {
  beforeEach(() => {
    querySpy.mockClear()
    delete process.env.KODY_TURN_TIMEOUT_SEC
  })
  afterEach(() => {
    delete process.env.KODY_TURN_TIMEOUT_SEC
  })

  it("returns outcome=completed when messages arrive within the window", async () => {
    queryGenFactory = async function* () {
      yield { type: "result", subtype: "success", result: "DONE" }
    }
    const res = await runAgent({ ...baseOpts, maxTurnTimeoutMs: 5000 })
    expect(res.outcome).toBe("completed")
    expect(res.error).toBeUndefined()
  })

  it("returns outcome=failed with a stall reason when a message takes too long", async () => {
    queryGenFactory = async function* () {
      // Never yield within the timeout window — simulate a hung tool call.
      await new Promise((resolve) => setTimeout(resolve, 500))
      yield { type: "result", subtype: "success", result: "DONE" }
    }
    const res = await runAgent({ ...baseOpts, maxTurnTimeoutMs: 100 })
    expect(res.outcome).toBe("failed")
    expect(res.error).toMatch(/stalled/i)
    expect(res.error).toMatch(/0s|1s/)
  })

  it("disables the watchdog when maxTurnTimeoutMs <= 0", async () => {
    queryGenFactory = async function* () {
      // Sleep long enough that any default watchdog would fire.
      await new Promise((resolve) => setTimeout(resolve, 200))
      yield { type: "result", subtype: "success", result: "DONE" }
    }
    const res = await runAgent({ ...baseOpts, maxTurnTimeoutMs: 0 })
    expect(res.outcome).toBe("completed")
  })

  it("honours KODY_TURN_TIMEOUT_SEC env override", async () => {
    process.env.KODY_TURN_TIMEOUT_SEC = "0"
    queryGenFactory = async function* () {
      await new Promise((resolve) => setTimeout(resolve, 200))
      yield { type: "result", subtype: "success", result: "DONE" }
    }
    const res = await runAgent({ ...baseOpts })
    expect(res.outcome).toBe("completed")
  })

  it("reports durationMs and messageCount in the result", async () => {
    queryGenFactory = async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "x" }] } }
      yield { type: "result", subtype: "success", result: "DONE" }
    }
    const res = await runAgent({ ...baseOpts, maxTurnTimeoutMs: 5000 })
    expect(res.messageCount).toBe(2)
    expect(typeof res.durationMs).toBe("number")
    expect(res.durationMs!).toBeGreaterThanOrEqual(0)
  })

  it("accumulates token usage across messages with `usage`", async () => {
    queryGenFactory = async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "x" }] },
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
      }
      yield {
        type: "result",
        subtype: "success",
        result: "DONE",
        usage: { input_tokens: 50, output_tokens: 30, cache_creation_input_tokens: 10 },
      }
    }
    const res = await runAgent({ ...baseOpts, maxTurnTimeoutMs: 5000 })
    expect(res.tokens?.input).toBe(150)
    expect(res.tokens?.output).toBe(50)
    expect(res.tokens?.cacheRead).toBe(50)
    expect(res.tokens?.cacheCreate).toBe(10)
  })
})
