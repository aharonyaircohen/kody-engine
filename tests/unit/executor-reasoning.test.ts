import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { runAgentSpy } = vi.hoisted(() => ({
  runAgentSpy: vi.fn(async (_opts: Record<string, unknown>) => ({
    outcome: "completed" as const,
    outcomeKind: "ok" as const,
    finalText: "done",
    durationMs: 1,
  })),
}))

vi.mock("../../src/agent.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/agent.js")>("../../src/agent.js")
  return { ...actual, runAgent: runAgentSpy }
})

vi.mock("../../src/litellm.js", () => ({
  startLitellmIfNeeded: vi.fn(async () => null),
}))

import { runImplementation } from "../../src/executor.js"

const originalCwd = process.cwd()
let dir: string

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

function writeProbeProfile(claudeCode: Record<string, unknown> = {}): void {
  const probeDir = path.join(dir, ".kody", "capabilities", "probe")
  writeJson(path.join(probeDir, "profile.json"), {
    name: "probe",
    role: "primitive",
    describe: "probe reasoning settings",
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
      ...claudeCode,
    },
    cliTools: [],
    scripts: { preflight: [{ script: "composePrompt" }], postflight: [] },
  })
  fs.writeFileSync(path.join(probeDir, "prompt.md"), "hello")
}

function writeConfig(agent: Record<string, unknown>): void {
  writeJson(path.join(dir, "kody.config.json"), {
    github: { owner: "o", repo: "r" },
    git: { defaultBranch: "main" },
    quality: {},
    agent: { model: "claude/base", ...agent },
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-executor-reasoning-"))
  process.chdir(dir)
  runAgentSpy.mockClear()
})

afterEach(() => {
  process.chdir(originalCwd)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("executor: reasoning effort resolution", () => {
  it("uses per-implementation reasoning effort over the global default", async () => {
    writeProbeProfile()
    writeConfig({
      reasoningEffort: "low",
      perImplementationReasoningEffort: { probe: "high" },
    })

    const out = await runImplementation("probe", { cliArgs: {}, cwd: dir })

    expect(out.exitCode).toBe(0)
    expect(runAgentSpy).toHaveBeenCalled()
    expect(runAgentSpy.mock.calls[0]![0].reasoningEffort).toBe("high")
  })

  it("uses profile reasoning effort over the global default", async () => {
    writeProbeProfile({ reasoningEffort: "medium" })
    writeConfig({ reasoningEffort: "low" })

    const out = await runImplementation("probe", { cliArgs: {}, cwd: dir })

    expect(out.exitCode).toBe(0)
    expect(runAgentSpy.mock.calls[0]![0].reasoningEffort).toBe("medium")
  })

  it("keeps raw profile thinking tokens over global reasoning effort", async () => {
    writeProbeProfile({ maxThinkingTokens: 8000 })
    writeConfig({ reasoningEffort: "low" })

    const out = await runImplementation("probe", { cliArgs: {}, cwd: dir })

    expect(out.exitCode).toBe(0)
    expect(runAgentSpy.mock.calls[0]![0].reasoningEffort).toBeUndefined()
    expect(runAgentSpy.mock.calls[0]![0].maxThinkingTokens).toBe(8000)
  })
})
