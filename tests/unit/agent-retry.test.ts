import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

let ndjsonDir: string
const baseOpts = (): RunAgentOpts => ({
  prompt: "hi",
  model: { provider: "minimax", model: "m" },
  cwd: process.cwd(),
  ndjsonDir,
  // Disable the per-turn watchdog so the only timer is the retry backoff
  // (flushed instantly via fake timers below).
  maxTurnTimeoutMs: 0,
})

const SUCCESS = { type: "result", subtype: "success", result: "DONE" }
// The dead-proxy signature: SDK reports subtype "success" but the session
// never reached the model — no result text, no usage (0 output tokens), $0.
const EMPTY_SUCCESS = { type: "result", subtype: "success", result: "" }
// A success that DID reach the model: empty result string but real output
// tokens. Must NOT be demoted — it produced work.
const SUCCESS_WITH_TOKENS = {
  type: "result",
  subtype: "success",
  result: "",
  usage: { input_tokens: 10, output_tokens: 42 },
}
const LOGIN_REQUIRED_TEXT = "Not logged in · Please run /login"
const LOGIN_REQUIRED_ASSISTANT = {
  type: "assistant",
  message: { content: [{ type: "text", text: LOGIN_REQUIRED_TEXT }] },
}
const LOGIN_REQUIRED_RESULT = {
  type: "result",
  subtype: "success",
  result: LOGIN_REQUIRED_TEXT,
}
const CONNECTION_ERR = "API Error: Unable to connect to API (ConnectionRefused)"
const writeToolUse = {
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "x" } }] },
}

/** Run runAgent while flushing the retry backoff timers instantly. */
async function runFlushed(opts: RunAgentOpts = baseOpts()) {
  vi.useFakeTimers()
  try {
    const promise = runAgent(opts)
    await vi.runAllTimersAsync()
    return await promise
  } finally {
    vi.useRealTimers()
  }
}

beforeEach(() => {
  ndjsonDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-agent-retry-test-"))
})

afterEach(() => {
  fs.rmSync(ndjsonDir, { recursive: true, force: true })
})

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
    const res = await runFlushed({ ...baseOpts(), ensureBackend })
    expect(ensureBackend).toHaveBeenCalledTimes(1)
    expect(res.outcome).toBe("completed")
  })

  it("calls ensureBackend once per retry until attempts are exhausted", async () => {
    attempts = [{ throw: CONNECTION_ERR }]
    const ensureBackend = vi.fn().mockResolvedValue(undefined)
    await runFlushed({ ...baseOpts(), ensureBackend })
    // 3 attempts total → recovery runs before retry 2 and retry 3.
    expect(ensureBackend).toHaveBeenCalledTimes(2)
  })

  it("does not call ensureBackend for a non-transient error", async () => {
    attempts = [{ throw: "Invalid API key" }]
    const ensureBackend = vi.fn().mockResolvedValue(undefined)
    await runFlushed({ ...baseOpts(), ensureBackend })
    expect(ensureBackend).not.toHaveBeenCalled()
  })

  it("retries even if ensureBackend itself throws", async () => {
    attempts = [{ throw: CONNECTION_ERR }, { messages: [SUCCESS] }]
    const ensureBackend = vi.fn().mockRejectedValue(new Error("restart failed"))
    const res = await runFlushed({ ...baseOpts(), ensureBackend })
    expect(ensureBackend).toHaveBeenCalledTimes(1)
    expect(res.outcome).toBe("completed")
  })
})

describe("runAgent: no-work success demotion", () => {
  beforeEach(() => {
    attempts = []
    callIndex = 0
  })

  it("demotes login-required text before a success result", async () => {
    attempts = [{ messages: [LOGIN_REQUIRED_ASSISTANT, SUCCESS_WITH_TOKENS] }, { messages: [SUCCESS] }]
    const ensureBackend = vi.fn().mockResolvedValue(undefined)
    const res = await runFlushed({ ...baseOpts(), ensureBackend })
    expect(callIndex).toBe(1)
    expect(res.outcome).toBe("failed")
    expect(res.outcomeKind).toBe("model_error")
    expect(res.error).toMatch(/not logged in/i)
    expect(ensureBackend).not.toHaveBeenCalled()
  })

  it("demotes login-required terminal success result", async () => {
    attempts = [{ messages: [LOGIN_REQUIRED_RESULT] }, { messages: [SUCCESS] }]
    const res = await runFlushed()
    expect(callIndex).toBe(1)
    expect(res.outcome).toBe("failed")
    expect(res.error).toMatch(/not logged in/i)
  })

  it("demotes a zero-output 'success' to failed (blocks the empty PR)", async () => {
    // Every attempt yields the dead-proxy success — recovery can't help, so it
    // exhausts retries and ends FAILED. A failed run skips commit + ensurePr,
    // so no empty PR is opened.
    attempts = [{ messages: [EMPTY_SUCCESS] }]
    const res = await runFlushed()
    expect(res.outcome).toBe("failed")
    expect(res.error).toMatch(/no model output/i)
  })

  it("runs ensureBackend on a no-work success (restarts a crashed proxy)", async () => {
    attempts = [{ messages: [EMPTY_SUCCESS] }]
    const ensureBackend = vi.fn().mockResolvedValue(undefined)
    await runFlushed({ ...baseOpts(), ensureBackend })
    // Same recovery path as a transient connection error: 2 retries.
    expect(ensureBackend).toHaveBeenCalledTimes(2)
  })

  it("recovers when a no-work success is followed by a real success", async () => {
    attempts = [{ messages: [EMPTY_SUCCESS] }, { messages: [SUCCESS] }]
    const ensureBackend = vi.fn().mockResolvedValue(undefined)
    const res = await runFlushed({ ...baseOpts(), ensureBackend })
    expect(ensureBackend).toHaveBeenCalledTimes(1)
    expect(res.outcome).toBe("completed")
  })

  it("does NOT demote a success that produced output tokens", async () => {
    attempts = [{ messages: [SUCCESS_WITH_TOKENS] }]
    const res = await runFlushed()
    expect(res.outcome).toBe("completed")
  })
})

describe("runAgent: hollow-success detection via backend health probe", () => {
  beforeEach(() => {
    attempts = []
    callIndex = 0
  })

  it("demotes a 'success' when the backend is dead right after the turn", async () => {
    // SUCCESS has non-empty finalText ("DONE"), so the zero-output heuristic
    // does NOT catch it — this is the A-Guy #2211 shape (proxy crashed
    // mid-request, SDK reported a hollow success carrying error text). The
    // health probe is the definitive signal.
    attempts = [{ messages: [SUCCESS] }]
    const isBackendHealthy = vi.fn().mockResolvedValue(false)
    const ensureBackend = vi.fn().mockResolvedValue(undefined)
    const res = await runFlushed({ ...baseOpts(), isBackendHealthy, ensureBackend })
    expect(res.outcome).toBe("failed")
    expect(res.error).toMatch(/proxy crashed mid-request|unreachable/i)
    // Demotion routed it through recovery: the proxy got a restart attempt.
    expect(ensureBackend).toHaveBeenCalled()
  })

  it("does NOT demote a 'success' when the backend is alive", async () => {
    attempts = [{ messages: [SUCCESS] }]
    const isBackendHealthy = vi.fn().mockResolvedValue(true)
    const res = await runFlushed({ ...baseOpts(), isBackendHealthy })
    expect(res.outcome).toBe("completed")
  })

  it("recovers when the backend comes back on retry", async () => {
    attempts = [{ messages: [SUCCESS] }, { messages: [SUCCESS] }]
    // Dead after attempt 1 → demote + restart; alive after attempt 2 → success.
    const isBackendHealthy = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const ensureBackend = vi.fn().mockResolvedValue(undefined)
    const res = await runFlushed({ ...baseOpts(), isBackendHealthy, ensureBackend })
    expect(res.outcome).toBe("completed")
    expect(ensureBackend).toHaveBeenCalledTimes(1)
  })
})
