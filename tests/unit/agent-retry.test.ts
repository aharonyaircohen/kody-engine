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

const baseOpts = {
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
async function runFlushed(opts = baseOpts) {
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
})
