import { beforeEach, describe, expect, it, vi } from "vitest"

// Programmable SDK mock: each query() call consumes the next spec. The
// generator yields any scripted messages first, then throws if `throw` is set
// — so a single attempt can run a tool and then hit a connection failure.
type Attempt = { messages?: unknown[]; throw?: string }
let attempts: Attempt[] = []
let callIndex = 0

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    const spec = attempts[callIndex] ?? attempts.at(-1) ?? {}
    callIndex++
    async function* gen() {
      for (const m of spec.messages ?? []) yield m
      if (spec.throw) throw new Error(spec.throw)
    }
    return gen()
  },
}))

import { runAgent } from "../../src/agent.js"

type RunAgentOpts = Parameters<typeof runAgent>[0]

const baseOpts: RunAgentOpts = {
  prompt: "hi",
  model: { provider: "minimax", model: "m" },
  cwd: process.cwd(),
  ndjsonDir: "/tmp/kody-agent-retry-test",
  // Disable the per-turn watchdog so the only timer is the retry backoff
  // (flushed instantly via fake timers below).
  maxTurnTimeoutMs: 0,
}

const SUCCESS = { type: "result", subtype: "success", result: "DONE" }
const CONNECTION_ERR = "API Error: Unable to connect to API (ConnectionRefused)"
const writeToolUse = {
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "x" } }] },
}

/** Run runAgent while flushing the retry backoff timers instantly. */
async function runFlushed(opts: RunAgentOpts = baseOpts) {
  vi.useFakeTimers()
  try {
    const promise = runAgent(opts)
    await vi.runAllTimersAsync()
    return await promise
  } finally {
    vi.useRealTimers()
  }
}

describe("runAgent: transient connection retry", () => {
  beforeEach(() => {
    attempts = []
    callIndex = 0
  })

  it("retries a ConnectionRefused failure and succeeds on the next attempt", async () => {
    attempts = [{ throw: CONNECTION_ERR }, { messages: [SUCCESS] }]
    const res = await runFlushed()
    expect(callIndex).toBe(2)
    expect(res.outcome).toBe("completed")
    expect(res.outcomeKind).toBe("ok")
  })

  it("gives up after MAX_CONNECTION_RETRIES (3 total attempts)", async () => {
    attempts = [{ throw: CONNECTION_ERR }]
    const res = await runFlushed()
    expect(callIndex).toBe(3)
    expect(res.outcome).toBe("failed")
    expect(res.outcomeKind).toBe("model_error")
  })

  it("does not retry a non-transient error", async () => {
    attempts = [{ throw: "Invalid API key" }, { messages: [SUCCESS] }]
    const res = await runFlushed()
    expect(callIndex).toBe(1)
    expect(res.outcome).toBe("failed")
  })

  it("latches a terminal success: a transient error after the success result does not replay", async () => {
    // The success `result` arrives, THEN the stream throws a connection drop on
    // its tail. The work is done — we must not downgrade to failed and replay
    // (which would discard the result and, for a read-only flow, re-run it).
    attempts = [{ messages: [SUCCESS], throw: CONNECTION_ERR }, { messages: [SUCCESS] }]
    const res = await runFlushed()
    expect(callIndex).toBe(1)
    expect(res.outcome).toBe("completed")
    expect(res.outcomeKind).toBe("ok")
  })

  it("does not retry once a mutating tool has run", async () => {
    // Mutating tool_use, then a connection failure on the next turn.
    attempts = [{ messages: [writeToolUse], throw: CONNECTION_ERR }, { messages: [SUCCESS] }]
    const res = await runFlushed()
    expect(callIndex).toBe(1)
    expect(res.outcome).toBe("failed")
  })

  it("still retries when only read tools have run", async () => {
    const readToolUse = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "gh pr list" } }] },
    }
    attempts = [{ messages: [readToolUse], throw: CONNECTION_ERR }, { messages: [SUCCESS] }]
    const res = await runFlushed()
    expect(callIndex).toBe(2)
    expect(res.outcome).toBe("completed")
  })

  it("calls ensureBackend before retrying a connection failure", async () => {
    attempts = [{ throw: CONNECTION_ERR }, { messages: [SUCCESS] }]
    const ensureBackend = vi.fn().mockResolvedValue(undefined)
    const res = await runFlushed({ ...baseOpts, ensureBackend })
    expect(ensureBackend).toHaveBeenCalledTimes(1)
    expect(res.outcome).toBe("completed")
  })

  it("calls ensureBackend once per retry until attempts are exhausted", async () => {
    attempts = [{ throw: CONNECTION_ERR }]
    const ensureBackend = vi.fn().mockResolvedValue(undefined)
    await runFlushed({ ...baseOpts, ensureBackend })
    // 3 attempts total → recovery runs before retry 2 and retry 3.
    expect(ensureBackend).toHaveBeenCalledTimes(2)
  })

  it("does not call ensureBackend for a non-transient error", async () => {
    attempts = [{ throw: "Invalid API key" }]
    const ensureBackend = vi.fn().mockResolvedValue(undefined)
    await runFlushed({ ...baseOpts, ensureBackend })
    expect(ensureBackend).not.toHaveBeenCalled()
  })

  it("retries even if ensureBackend itself throws", async () => {
    attempts = [{ throw: CONNECTION_ERR }, { messages: [SUCCESS] }]
    const ensureBackend = vi.fn().mockRejectedValue(new Error("restart failed"))
    const res = await runFlushed({ ...baseOpts, ensureBackend })
    expect(ensureBackend).toHaveBeenCalledTimes(1)
    expect(res.outcome).toBe("completed")
  })
})
