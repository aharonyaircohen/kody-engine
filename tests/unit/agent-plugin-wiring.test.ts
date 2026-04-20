import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Verifies that agent.ts forwards the four profile-level extensions
 * (plugins, maxTurns, systemPromptAppend, and synthetic-plugin paths)
 * to the SDK's `query()` options without actually invoking the agent.
 */

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "result", subtype: "success", result: "DONE" }
    },
  })),
}))

vi.mock("../../src/litellm.js", () => ({
  startLitellmIfNeeded: vi.fn(async () => null),
}))

import { query } from "@anthropic-ai/claude-agent-sdk"

const baseOpts = {
  prompt: "test",
  model: { provider: "claude" as const, model: "claude-haiku-4-5-20251001" },
  cwd: process.cwd(),
}

describe("agent plugin-path forwarding", () => {
  beforeEach(() => vi.mocked(query).mockClear())
  afterEach(() => vi.clearAllMocks())

  it("maps pluginPaths → plugins: [{type:'local', path}]", async () => {
    const { runAgent } = await import("../../src/agent.js")
    await runAgent({ ...baseOpts, pluginPaths: ["/tmp/plugin-a", "/abs/plugin-b"] })
    const opts = vi.mocked(query).mock.calls[0]![0].options as Record<string, unknown>
    expect(opts.plugins).toEqual([
      { type: "local", path: "/tmp/plugin-a" },
      { type: "local", path: "/abs/plugin-b" },
    ])
  })

  it("omits plugins when pluginPaths is empty", async () => {
    const { runAgent } = await import("../../src/agent.js")
    await runAgent({ ...baseOpts, pluginPaths: [] })
    const opts = vi.mocked(query).mock.calls[0]![0].options as Record<string, unknown>
    expect(opts.plugins).toBeUndefined()
  })

  it("omits plugins when pluginPaths is not provided", async () => {
    const { runAgent } = await import("../../src/agent.js")
    await runAgent({ ...baseOpts })
    const opts = vi.mocked(query).mock.calls[0]![0].options as Record<string, unknown>
    expect(opts.plugins).toBeUndefined()
  })
})

describe("agent maxTurns forwarding", () => {
  beforeEach(() => vi.mocked(query).mockClear())
  afterEach(() => vi.clearAllMocks())

  it("forwards positive maxTurns", async () => {
    const { runAgent } = await import("../../src/agent.js")
    await runAgent({ ...baseOpts, maxTurns: 15 })
    const opts = vi.mocked(query).mock.calls[0]![0].options as Record<string, unknown>
    expect(opts.maxTurns).toBe(15)
  })

  it("omits maxTurns when null", async () => {
    const { runAgent } = await import("../../src/agent.js")
    await runAgent({ ...baseOpts, maxTurns: null })
    const opts = vi.mocked(query).mock.calls[0]![0].options as Record<string, unknown>
    expect(opts.maxTurns).toBeUndefined()
  })

  it("omits maxTurns when 0 or negative (defensive)", async () => {
    const { runAgent } = await import("../../src/agent.js")
    await runAgent({ ...baseOpts, maxTurns: 0 })
    const opts = vi.mocked(query).mock.calls[0]![0].options as Record<string, unknown>
    expect(opts.maxTurns).toBeUndefined()
  })
})

describe("agent systemPromptAppend forwarding", () => {
  beforeEach(() => vi.mocked(query).mockClear())
  afterEach(() => vi.clearAllMocks())

  it("forwards systemPrompt as {type:preset, preset:claude_code, append}", async () => {
    const { runAgent } = await import("../../src/agent.js")
    await runAgent({ ...baseOpts, systemPromptAppend: "Be terse." })
    const opts = vi.mocked(query).mock.calls[0]![0].options as Record<string, unknown>
    expect(opts.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "Be terse." })
  })

  it("omits systemPrompt when append is null or empty", async () => {
    const { runAgent } = await import("../../src/agent.js")
    await runAgent({ ...baseOpts, systemPromptAppend: null })
    const opts = vi.mocked(query).mock.calls[0]![0].options as Record<string, unknown>
    expect(opts.systemPrompt).toBeUndefined()

    vi.mocked(query).mockClear()
    await runAgent({ ...baseOpts, systemPromptAppend: "" })
    const opts2 = vi.mocked(query).mock.calls[0]![0].options as Record<string, unknown>
    expect(opts2.systemPrompt).toBeUndefined()
  })
})
