import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const querySpy = vi.fn()

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => {
    querySpy(args)
    async function* empty() {
      yield { type: "result", subtype: "success", result: "DONE" }
    }
    return empty()
  },
}))

import { runAgent } from "../../src/agent.js"

const baseOpts = {
  prompt: "hi",
  model: { provider: "minimax", model: "m" },
  cwd: process.cwd(),
  ndjsonDir: "/tmp/kody2-agent-test",
}

describe("runAgent: settingSources passthrough", () => {
  beforeEach(() => {
    querySpy.mockClear()
  })
  afterEach(() => {
    querySpy.mockClear()
  })

  it("defaults settingSources to ['project', 'local']", async () => {
    await runAgent(baseOpts)
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options.settingSources).toEqual(["project", "local"])
  })

  it("honours explicit settingSources override", async () => {
    await runAgent({ ...baseOpts, settingSources: [] })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options.settingSources).toEqual([])
  })

  it("honours a single-source override", async () => {
    await runAgent({ ...baseOpts, settingSources: ["user"] })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options.settingSources).toEqual(["user"])
  })
})

describe("runAgent: maxThinkingTokens passthrough", () => {
  beforeEach(() => {
    querySpy.mockClear()
  })
  afterEach(() => {
    querySpy.mockClear()
  })

  it("forwards maxThinkingTokens to the SDK when positive", async () => {
    await runAgent({ ...baseOpts, maxThinkingTokens: 10_000 })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options.maxThinkingTokens).toBe(10_000)
  })

  it("omits maxThinkingTokens when unset", async () => {
    await runAgent(baseOpts)
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options).not.toHaveProperty("maxThinkingTokens")
  })

  it("omits maxThinkingTokens when null", async () => {
    await runAgent({ ...baseOpts, maxThinkingTokens: null })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options).not.toHaveProperty("maxThinkingTokens")
  })

  it("omits maxThinkingTokens when zero or negative", async () => {
    await runAgent({ ...baseOpts, maxThinkingTokens: 0 })
    const argsZero = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(argsZero.options).not.toHaveProperty("maxThinkingTokens")

    querySpy.mockClear()

    await runAgent({ ...baseOpts, maxThinkingTokens: -1 })
    const argsNeg = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(argsNeg.options).not.toHaveProperty("maxThinkingTokens")
  })
})
