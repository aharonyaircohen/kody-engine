import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Verifies that `profile.claudeCode.mcpServers` entries flow from the profile
 * through the executor into the SDK `query()` call.
 *
 * We stub `@anthropic-ai/claude-agent-sdk` so the test can inspect the options
 * that would be sent, without actually invoking the agent.
 */

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => ({
    // One result message so the agent loop exits.
    async *[Symbol.asyncIterator]() {
      yield { type: "result", subtype: "success", result: "DONE" }
    },
  })),
}))

// Avoid actual LiteLLM spawning in tests.
vi.mock("../../src/litellm.js", () => ({
  startLitellmIfNeeded: vi.fn(async () => null),
}))

import { query } from "@anthropic-ai/claude-agent-sdk"

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "kody-mcp-"))

function writeProfile(root: string, name: string, mcpServers: unknown[]): string {
  const dir = path.join(root, "executables", name)
  fs.mkdirSync(dir, { recursive: true })
  const profile = {
    name,
    describe: "test",
    inputs: [],
    claudeCode: {
      model: "claude/claude-haiku-4-5-20251001",
      permissionMode: "acceptEdits",
      tools: ["Read"],
      mcpServers,
    },
    cliTools: [],
    scripts: { preflight: [], postflight: [] },
  }
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile, null, 2))
  return path.join(dir, "profile.json")
}

describe("MCP wiring: profile.claudeCode.mcpServers → SDK query options", () => {
  beforeEach(() => {
    vi.mocked(query).mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("transforms mcpServers array into the SDK's record shape (keyed by name)", async () => {
    const root = tmp()
    const mcpServers = [
      { name: "playwright", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      { name: "other", command: "node", args: ["./other.js"], env: { FOO: "bar" } },
    ]
    writeProfile(root, "with-mcp", mcpServers)

    const { runAgent } = await import("../../src/agent.js")
    await runAgent({
      prompt: "test",
      model: { provider: "claude", model: "claude-haiku-4-5-20251001" },
      cwd: root,
      mcpServers,
    })

    expect(query).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(query).mock.calls[0]![0].options as Record<string, unknown>
    expect(opts.mcpServers).toEqual({
      playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      other: { command: "node", args: ["./other.js"], env: { FOO: "bar" } },
    })
  })

  it("omits mcpServers from options when empty (no-op for agent)", async () => {
    const { runAgent } = await import("../../src/agent.js")
    await runAgent({
      prompt: "test",
      model: { provider: "claude", model: "claude-haiku-4-5-20251001" },
      cwd: process.cwd(),
      mcpServers: [],
    })

    const opts = vi.mocked(query).mock.calls[0]![0].options as Record<string, unknown>
    expect(opts.mcpServers).toBeUndefined()
  })

  it("omits mcpServers entirely when not provided", async () => {
    const { runAgent } = await import("../../src/agent.js")
    await runAgent({
      prompt: "test",
      model: { provider: "claude", model: "claude-haiku-4-5-20251001" },
      cwd: process.cwd(),
    })

    const opts = vi.mocked(query).mock.calls[0]![0].options as Record<string, unknown>
    expect(opts.mcpServers).toBeUndefined()
  })
})
