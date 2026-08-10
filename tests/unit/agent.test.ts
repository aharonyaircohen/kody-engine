import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const querySpy = vi.fn()
// Per-test override of the generator yielded by the mocked SDK's query()
// so individual tests can exercise multi-result behavior.
let queryMessages: unknown[] = [{ type: "result", subtype: "success", result: "DONE" }]

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (config: Record<string, unknown>) => config,
  query: (args: unknown) => {
    querySpy(args)
    const msgs = queryMessages
    async function* gen() {
      for (const m of msgs) yield m
    }
    return gen()
  },
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
  }),
}))

import { runAgent } from "../../src/agent.js"
import { REASONING_BUDGETS } from "../../src/config.js"

let ndjsonDir: string
const baseOpts = () => ({
  prompt: "hi",
  model: { provider: "minimax", model: "m" },
  cwd: process.cwd(),
  ndjsonDir,
})

beforeEach(() => {
  ndjsonDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-agent-test-"))
})

afterEach(() => {
  fs.rmSync(ndjsonDir, { recursive: true, force: true })
})

describe("runAgent: settingSources passthrough", () => {
  beforeEach(() => {
    querySpy.mockClear()
  })
  afterEach(() => {
    querySpy.mockClear()
  })

  it("defaults settingSources to ['project', 'local']", async () => {
    await runAgent(baseOpts())
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options.settingSources).toEqual(["project", "local"])
  })

  it("honours explicit settingSources override", async () => {
    await runAgent({ ...baseOpts(), settingSources: [] })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options.settingSources).toEqual([])
  })

  it("honours a single-source override", async () => {
    await runAgent({ ...baseOpts(), settingSources: ["user"] })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options.settingSources).toEqual(["user"])
  })
})

describe("runAgent: output contract hooks", () => {
  it("wires write feedback and Journey continuation for contracted output", async () => {
    querySpy.mockClear()
    const outputPath = path.join(ndjsonDir, "result.json")
    fs.writeFileSync(outputPath, JSON.stringify({ version: 1 }))

    await runAgent({
      ...baseOpts(),
      outputContract: {
        path: outputPath,
        schema: {
          type: "object",
          required: ["version"],
          properties: { version: { const: 1 } },
        },
      },
    })

    const args = querySpy.mock.calls[0]![0] as {
      options: { hooks: { PostToolUse: Array<{ matcher?: string }>; Stop?: Array<unknown> } }
    }
    expect(args.options.hooks.PostToolUse.map((entry) => entry.matcher)).toContain("Write")
    expect(args.options.hooks.Stop).toHaveLength(1)
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
    await runAgent({ ...baseOpts(), maxThinkingTokens: 10_000 })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options.maxThinkingTokens).toBe(10_000)
  })

  it("omits maxThinkingTokens when unset", async () => {
    await runAgent(baseOpts())
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options).not.toHaveProperty("maxThinkingTokens")
  })

  it("omits maxThinkingTokens when null", async () => {
    await runAgent({ ...baseOpts(), maxThinkingTokens: null })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options).not.toHaveProperty("maxThinkingTokens")
  })

  it("omits maxThinkingTokens when zero or negative", async () => {
    await runAgent({ ...baseOpts(), maxThinkingTokens: 0 })
    const argsZero = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(argsZero.options).not.toHaveProperty("maxThinkingTokens")

    querySpy.mockClear()

    await runAgent({ ...baseOpts(), maxThinkingTokens: -1 })
    const argsNeg = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(argsNeg.options).not.toHaveProperty("maxThinkingTokens")
  })
})

describe("runAgent: reasoningEffort → maxThinkingTokens mapping", () => {
  beforeEach(() => {
    querySpy.mockClear()
  })
  afterEach(() => {
    querySpy.mockClear()
  })

  it("omits maxThinkingTokens when reasoningEffort is unset (cheapest path)", async () => {
    await runAgent(baseOpts())
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options).not.toHaveProperty("maxThinkingTokens")
  })

  it("omits maxThinkingTokens when reasoningEffort is null", async () => {
    await runAgent({ ...baseOpts(), reasoningEffort: null })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options).not.toHaveProperty("maxThinkingTokens")
  })

  it("omits maxThinkingTokens when reasoningEffort is 'off' (explicit no-thinking)", async () => {
    await runAgent({ ...baseOpts(), reasoningEffort: "off" })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options).not.toHaveProperty("maxThinkingTokens")
  })

  it("maps 'low' → REASONING_BUDGETS.low tokens", async () => {
    await runAgent({ ...baseOpts(), reasoningEffort: "low" })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options.maxThinkingTokens).toBe(REASONING_BUDGETS.low)
  })

  it("maps 'medium' → REASONING_BUDGETS.medium tokens", async () => {
    await runAgent({ ...baseOpts(), reasoningEffort: "medium" })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options.maxThinkingTokens).toBe(REASONING_BUDGETS.medium)
  })

  it("maps 'high' → REASONING_BUDGETS.high tokens", async () => {
    await runAgent({ ...baseOpts(), reasoningEffort: "high" })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options.maxThinkingTokens).toBe(REASONING_BUDGETS.high)
  })

  it("reasoningEffort wins over explicit maxThinkingTokens when both are set", async () => {
    // User-facing field is canonical — never let a stale budget value
    // override the level the user picked in the chat.
    await runAgent({ ...baseOpts(), reasoningEffort: "low", maxThinkingTokens: 99_999 })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options.maxThinkingTokens).toBe(REASONING_BUDGETS.low)
  })

  it("'off' wins over explicit maxThinkingTokens too (no thinking block at all)", async () => {
    await runAgent({ ...baseOpts(), reasoningEffort: "off", maxThinkingTokens: 32_000 })
    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options).not.toHaveProperty("maxThinkingTokens")
  })
})

describe("runAgent: finalText collection", () => {
  beforeEach(() => {
    queryMessages = [{ type: "result", subtype: "success", result: "DONE" }]
  })
  afterEach(() => {
    queryMessages = [{ type: "result", subtype: "success", result: "DONE" }]
  })

  it("concatenates multiple result messages so earlier DONE markers survive", async () => {
    // SDK can emit several `result` events when the session restarts
    // mid-flight. Preserving only the last one clobbers valid DONE
    // markers from earlier turns.
    queryMessages = [
      { type: "result", subtype: "success", result: "DONE\nCOMMIT_MSG: fix: x\nPR_SUMMARY:\n- x" },
      { type: "result", subtype: "success", result: "background check complete" },
    ]
    const out = await runAgent(baseOpts())
    expect(out.outcome).toBe("completed")
    expect(out.finalText).toMatch(/^DONE/)
    expect(out.finalText).toContain("COMMIT_MSG: fix: x")
    expect(out.finalText).toContain("background check complete")
  })

  it("drops empty result payloads from the concatenation", async () => {
    queryMessages = [
      { type: "result", subtype: "success", result: "   " },
      { type: "result", subtype: "success", result: "DONE" },
    ]
    const out = await runAgent(baseOpts())
    expect(out.finalText).toBe("DONE")
  })
})

describe("runAgent: Dashboard CMS MCP wiring", () => {
  beforeEach(() => {
    querySpy.mockClear()
  })
  afterEach(() => {
    querySpy.mockClear()
  })

  it("registers the Dashboard CMS server and allowlist when explicitly enabled", async () => {
    await runAgent({
      ...baseOpts(),
      enableDashboardCmsTool: true,
      cmsDashboardUrl: "https://dashboard.example.test",
      cmsRepoSlug: "owner/repo",
      cmsToken: "test-token",
    })

    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    const mcpServers = args.options.mcpServers as Record<string, { name?: string }>
    const allowedTools = args.options.allowedTools as string[]
    expect(mcpServers["kody-cms"]).toMatchObject({ name: "kody-cms" })
    expect(allowedTools).toContain("mcp__kody-cms__cms_list_documents")
    expect(allowedTools).toContain("mcp__kody-cms__cms_get_document")
  })

  it("forwards a hard tool denylist to the SDK", async () => {
    await runAgent({
      ...baseOpts(),
      allowedToolsOverride: ["Write", "mcp__playwright"],
      disallowedToolsOverride: ["Bash", "Read", "TodoWrite"],
    })

    const args = querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(args.options.disallowedTools).toEqual(["Bash", "Read", "TodoWrite"])
  })
})
