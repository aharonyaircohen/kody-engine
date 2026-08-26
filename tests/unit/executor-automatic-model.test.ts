import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { runAgentSpy, startAutomaticLitellmSpy, startLitellmIfNeededSpy } = vi.hoisted(() => ({
  runAgentSpy: vi.fn(),
  startAutomaticLitellmSpy: vi.fn(),
  startLitellmIfNeededSpy: vi.fn(async () => null),
}))

vi.mock("../../src/agent.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/agent.js")>("../../src/agent.js")
  return { ...actual, runAgent: runAgentSpy }
})

vi.mock("../../src/litellm.js", () => ({
  startAutomaticLitellm: startAutomaticLitellmSpy,
  startLitellmIfNeeded: startLitellmIfNeededSpy,
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
  startAutomaticLitellmSpy.mockReset()
  startAutomaticLitellmSpy.mockResolvedValue({
    url: "http://127.0.0.1:4010",
    modelGroup: "kody-automatic-0",
    kill: vi.fn(),
    isHealthy: vi.fn(async () => true),
    ensureHealthy: vi.fn(async () => true),
  })
  startLitellmIfNeededSpy.mockClear()
  writeFixture()
})

afterEach(() => {
  process.chdir(originalCwd)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("executor: Automatic model fallback", () => {
  it("runs one agent session through the ordered Automatic gateway", async () => {
    runAgentSpy.mockResolvedValue({
      outcome: "completed",
      outcomeKind: "ok",
      safeToReplay: false,
      finalText: "done",
    })

    const out = await runImplementation("probe", { cliArgs: {}, cwd: dir })

    expect(out.exitCode).toBe(0)
    expect(startAutomaticLitellmSpy).toHaveBeenCalledWith(
      [
        expect.objectContaining({ provider: "anthropic", model: "first" }),
        expect.objectContaining({ provider: "openai", model: "second" }),
      ],
      dir,
      expect.any(Object),
    )
    expect(startLitellmIfNeededSpy).not.toHaveBeenCalled()
    expect(runAgentSpy).toHaveBeenCalledTimes(1)
    expect(runAgentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        litellmUrl: "http://127.0.0.1:4010",
        litellmModelGroupOverride: "kody-automatic-0",
      }),
    )
  })

  it("returns the gateway result without replaying the agent session", async () => {
    runAgentSpy.mockResolvedValue({
      outcome: "failed",
      outcomeKind: "rate_limit",
      safeToReplay: false,
      finalText: "",
    })
    await runImplementation("probe", { cliArgs: {}, cwd: dir })
    expect(runAgentSpy).toHaveBeenCalledTimes(1)

    expect(runAgentSpy).toHaveBeenCalledTimes(1)
  })

  it("leaves an explicitly selected model on the existing direct path", async () => {
    writeJson(path.join(dir, "kody.config.json"), {
      github: { owner: "o", repo: "r" },
      git: { defaultBranch: "main" },
      quality: {},
      agent: { model: "anthropic/first" },
    })
    runAgentSpy.mockResolvedValue({
      outcome: "completed",
      outcomeKind: "ok",
      safeToReplay: false,
      finalText: "done",
    })

    await runImplementation("probe", { cliArgs: {}, cwd: dir })

    expect(startAutomaticLitellmSpy).not.toHaveBeenCalled()
    expect(startLitellmIfNeededSpy).toHaveBeenCalledTimes(1)
    expect(runAgentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ provider: "anthropic", model: "first" }),
        litellmUrl: null,
      }),
    )
  })

  it("uses fixed custom-model runtime details", async () => {
    writeJson(path.join(dir, "kody.config.json"), {
      github: { owner: "o", repo: "r" },
      git: { defaultBranch: "main" },
      quality: {},
      agent: {
        model: "openai/ox-alpha",
        modelConfig: {
          spec: "openai/ox-alpha",
          provider: "custom",
          protocol: "openai",
          baseURL: "https://oxalpha.run/api/v1",
          modelName: "ox-alpha",
          apiKeyEnvVar: "OXALPHA_API_KEY",
        },
      },
    })
    runAgentSpy.mockResolvedValue({
      outcome: "completed",
      outcomeKind: "ok",
      safeToReplay: false,
      finalText: "done",
    })

    await runImplementation("probe", { cliArgs: {}, cwd: dir })

    expect(startLitellmIfNeededSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "custom",
        litellmProvider: "openai",
        model: "ox-alpha",
        spec: "openai/ox-alpha",
        baseURL: "https://oxalpha.run/api/v1",
        apiKeyEnvVar: "OXALPHA_API_KEY",
      }),
      dir,
      undefined,
      expect.any(Object),
    )
  })
})
