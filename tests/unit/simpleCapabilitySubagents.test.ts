import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { runAgentSpy } = vi.hoisted(() => ({
  runAgentSpy: vi.fn(async (_opts: Record<string, unknown>) => ({
    outcome: "completed" as const,
    outcomeKind: "ok" as const,
    finalText: "{}",
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
import type { Profile } from "../../src/implementations/types.js"
import { loadSimpleCapability } from "../../src/scripts/loadSimpleCapability.js"
import { loadSubagents } from "../../src/subagents.js"

const roots: string[] = []

beforeEach(() => {
  runAgentSpy.mockClear()
})

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(execution: "agent" | "script" = "agent") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-capability-subagents-"))
  roots.push(cwd)
  const capabilityDir = path.join(cwd, ".kody-engine", "definitions", "capabilities", "document")
  fs.mkdirSync(path.join(capabilityDir, "skills"), { recursive: true })
  fs.mkdirSync(path.join(capabilityDir, "tools", "agents"), { recursive: true })
  fs.writeFileSync(path.join(capabilityDir, "instructions.md"), "Create documentation.\n")
  fs.writeFileSync(
    path.join(capabilityDir, "contract.json"),
    JSON.stringify({
      execution,
      input: { type: "object" },
      output: { type: "object" },
    }),
  )
  if (execution === "script") {
    fs.writeFileSync(path.join(capabilityDir, "tools", "run.sh"), "#!/bin/sh\nprintf '{}'\n")
  }

  const profile = {
    name: "capability-run",
    role: "primitive",
    describe: "Run one simple capability",
    kind: "oneshot",
    inputs: [],
    claudeCode: {
      model: "inherit",
      permissionMode: "acceptEdits",
      maxTurns: 60,
      maxThinkingTokens: null,
      systemPromptAppend: null,
      tools: ["Read", "Bash"],
      hooks: [],
      skills: [],
      commands: [],
      subagents: [],
      plugins: [],
      mcpServers: [],
    },
    cliTools: [],
    scripts: { preflight: [], postflight: [] },
    inputArtifacts: [],
    outputArtifacts: [],
    dir: path.join(cwd, "runtime"),
  } as Profile
  const ctx = {
    cwd,
    args: { capability: "document", input: {} },
    data: {},
    output: {},
  }
  return { capabilityDir, ctx, profile }
}

describe("simple Capability private subagents", () => {
  it("registers capability-owned agent files as callable subagents", async () => {
    const { capabilityDir, ctx, profile } = fixture()
    fs.writeFileSync(
      path.join(capabilityDir, "tools", "agents", "researcher.md"),
      "---\nname: researcher\ndescription: Find source evidence.\ntools: Read, Grep, Glob\n---\nResearch every claim.\n",
    )
    fs.writeFileSync(
      path.join(capabilityDir, "tools", "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Independently review the draft.\n---\nReject unsupported claims.\n",
    )

    await loadSimpleCapability(ctx as never, profile)

    expect(profile.claudeCode.subagents).toEqual(["researcher", "reviewer"])
    expect(profile.claudeCode.tools).toContain("Agent")
    expect(loadSubagents(profile)).toEqual({
      researcher: {
        description: "Find source evidence.",
        prompt: "Research every claim.",
        tools: ["Read", "Grep", "Glob"],
      },
      reviewer: {
        description: "Independently review the draft.",
        prompt: "Reject unsupported claims.",
      },
    })
  })

  it("does not enable subagents for a script-backed capability", async () => {
    const { capabilityDir, ctx, profile } = fixture("script")
    fs.writeFileSync(
      path.join(capabilityDir, "tools", "agents", "unused.md"),
      "---\nname: unused\ndescription: Must not run.\n---\nDo not run.\n",
    )

    await loadSimpleCapability(ctx as never, profile)

    expect(profile.claudeCode.subagents).toEqual([])
    expect(profile.claudeCode.tools).not.toContain("Agent")
    expect(loadSubagents(profile)).toBeUndefined()
  })

  it("passes discovered subagents and the Agent tool to the real Capability execution boundary", async () => {
    const { capabilityDir, ctx } = fixture()
    fs.writeFileSync(
      path.join(capabilityDir, "tools", "agents", "researcher.md"),
      "---\nname: researcher\ndescription: Find source evidence.\n---\nResearch every claim.\n",
    )

    const result = await runImplementation("capability-run", {
      cwd: ctx.cwd,
      cliArgs: { ...ctx.args, input: "{}" },
      config: {
        github: { owner: "", repo: "" },
        git: { defaultBranch: "main" },
        quality: { typecheck: "", lint: "", testUnit: "", format: "" },
        agent: { model: "claude/test" },
      },
    })

    expect(result.exitCode).toBe(0)
    expect(runAgentSpy).toHaveBeenCalledOnce()
    expect(runAgentSpy.mock.calls[0]![0]).toMatchObject({
      allowedToolsOverride: expect.arrayContaining(["Agent"]),
      agents: {
        researcher: {
          description: "Find source evidence.",
          prompt: "Research every claim.",
        },
      },
    })
  })
})
