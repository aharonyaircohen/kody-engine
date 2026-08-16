import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { runAgentSpy } = vi.hoisted(() => ({ runAgentSpy: vi.fn() }))

vi.mock("../../src/agent.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/agent.js")>("../../src/agent.js")
  return { ...actual, runAgent: runAgentSpy }
})

vi.mock("../../src/litellm.js", () => ({
  startLitellmIfNeeded: vi.fn(async () => null),
}))

vi.mock("../../src/runtimeModelEnvironment.js", () => ({
  resolveRuntimeModelEnvironment: vi.fn(async () => ({ environment: {}, warnings: [] })),
}))

import { runImplementation } from "../../src/executor.js"

const originalCwd = process.cwd()
let dir: string

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

function writeFixture(): void {
  const profileDir = path.join(dir, ".kody-engine", "definitions", "implementations", "probe")
  writeJson(path.join(profileDir, "profile.json"), {
    name: "probe",
    role: "primitive",
    describe: "probe Automatic model fallback",
    inputs: [],
    claudeCode: {
      model: "inherit",
      permissionMode: "default",
      maxTurns: null,
      maxThinkingTokens: null,
      systemPromptAppend: null,
      tools: ["Read"],
      hooks: [],
      skills: [],
      commands: [],
      subagents: [],
      plugins: [],
      mcpServers: [],
    },
    cliTools: [],
    scripts: { preflight: [{ script: "composePrompt" }], postflight: [] },
  })
  fs.writeFileSync(path.join(profileDir, "prompt.md"), "hello")
  writeJson(path.join(dir, "kody.config.json"), {
    github: { owner: "o", repo: "r" },
    git: { defaultBranch: "main" },
    quality: {},
    agent: {
      model: "automatic",
      automaticModels: [
        {
          spec: "anthropic/first",
          provider: "anthropic",
          protocol: "anthropic",
          modelName: "first",
          apiKeyEnvVar: "ANTHROPIC_API_KEY",
        },
        {
          spec: "openai/second",
          provider: "openai",
          protocol: "openai",
          baseURL: "https://api.openai.com/v1",
          modelName: "second",
          apiKeyEnvVar: "OPENAI_API_KEY",
        },
      ],
    },
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-executor-automatic-"))
  process.chdir(dir)
  runAgentSpy.mockReset()
  writeFixture()
})

afterEach(() => {
  process.chdir(originalCwd)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("executor: Automatic model fallback", () => {
  it("tries the next configured model after a safe rate-limit failure", async () => {
    runAgentSpy
      .mockResolvedValueOnce({
        outcome: "failed",
        outcomeKind: "rate_limit",
        safeToReplay: true,
        finalText: "",
      })
      .mockResolvedValueOnce({
        outcome: "completed",
        outcomeKind: "ok",
        safeToReplay: false,
        finalText: "done",
      })

    const out = await runImplementation("probe", { cliArgs: {}, cwd: dir })

    expect(out.exitCode).toBe(0)
    expect(runAgentSpy).toHaveBeenCalledTimes(2)
    expect(runAgentSpy.mock.calls.map((call) => call[0].model)).toEqual([
      expect.objectContaining({ provider: "anthropic", model: "first" }),
      expect.objectContaining({ provider: "openai", model: "second" }),
    ])
  })

  it("does not switch models after side effects or for a non-rate-limit error", async () => {
    runAgentSpy.mockResolvedValue({
      outcome: "failed",
      outcomeKind: "rate_limit",
      safeToReplay: false,
      finalText: "",
    })
    await runImplementation("probe", { cliArgs: {}, cwd: dir })
    expect(runAgentSpy).toHaveBeenCalledTimes(1)

    runAgentSpy.mockReset()
    runAgentSpy.mockResolvedValue({
      outcome: "failed",
      outcomeKind: "model_error",
      safeToReplay: true,
      finalText: "",
    })
    await runImplementation("probe", { cliArgs: {}, cwd: dir })
    expect(runAgentSpy).toHaveBeenCalledTimes(1)
  })
})
