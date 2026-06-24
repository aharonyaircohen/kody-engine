import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const querySpy = vi.fn()
const baseGen = async function* () {
  yield { type: "result", subtype: "success", result: "DONE" }
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => {
    querySpy(args)
    return baseGen()
  },
}))

import { runAgent } from "../../src/agent.js"

let ndjsonDir: string
const baseOpts = () => ({
  prompt: "hi",
  model: { provider: "minimax", model: "m" },
  cwd: process.cwd(),
  ndjsonDir,
})

beforeEach(() => {
  ndjsonDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-cacheable-test-"))
})

afterEach(() => {
  fs.rmSync(ndjsonDir, { recursive: true, force: true })
})

describe("runAgent: cacheable opt-in (Phase 2/B3)", () => {
  beforeEach(() => querySpy.mockClear())
  afterEach(() => querySpy.mockClear())

  it("does not set excludeDynamicSections when cacheable is unset", async () => {
    await runAgent({ ...baseOpts(), systemPromptAppend: "extra instructions" })
    const args = querySpy.mock.calls[0]![0] as { options: { systemPrompt?: Record<string, unknown> } }
    expect(args.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "extra instructions",
    })
  })

  it("sets excludeDynamicSections=true on the preset when cacheable=true (with append)", async () => {
    await runAgent({ ...baseOpts(), systemPromptAppend: "extra instructions", cacheable: true })
    const args = querySpy.mock.calls[0]![0] as { options: { systemPrompt?: Record<string, unknown> } }
    expect(args.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "extra instructions",
      excludeDynamicSections: true,
    })
  })

  it("emits the cacheable preset even when no append is provided", async () => {
    await runAgent({ ...baseOpts(), cacheable: true })
    const args = querySpy.mock.calls[0]![0] as { options: { systemPrompt?: Record<string, unknown> } }
    expect(args.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      excludeDynamicSections: true,
    })
  })

  it("does not emit systemPrompt at all when neither cacheable nor append is set", async () => {
    await runAgent({ ...baseOpts() })
    const args = querySpy.mock.calls[0]![0] as { options: { systemPrompt?: unknown } }
    expect(args.options.systemPrompt).toBeUndefined()
  })
})
