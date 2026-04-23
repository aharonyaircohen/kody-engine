import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import type { Profile } from "../../src/executables/types.js"
import { buildSyntheticPlugin, getPluginsCatalogRoot } from "../../src/scripts/buildSyntheticPlugin.js"

function makeCtx(): {
  args: Record<string, unknown>
  cwd: string
  config: any
  data: Record<string, unknown>
  output: { exitCode: number }
} {
  return {
    args: { issue: 1 },
    cwd: os.tmpdir(),
    config: {
      quality: { typecheck: "", lint: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/x" },
    },
    data: {},
    output: { exitCode: 0 },
  }
}

function makeProfile(partial: Partial<Profile["claudeCode"]>): Profile {
  return {
    name: "plan-verify",
    role: "utility",
    describe: "test",
    kind: "oneshot",
    inputs: [],
    claudeCode: {
      model: "inherit",
      permissionMode: "default",
      maxTurns: null,
      maxThinkingTokens: null,
      systemPromptAppend: null,
      tools: [],
      hooks: [],
      skills: [],
      commands: [],
      subagents: [],
      plugins: [],
      mcpServers: [],
      ...partial,
    },
    cliTools: [],
    scripts: { preflight: [], postflight: [] },
    inputArtifacts: [],
    outputArtifacts: [],
    dir: "/tmp/fake",
  }
}

describe("buildSyntheticPlugin: catalog root", () => {
  it("resolves to an existing directory", () => {
    const root = getPluginsCatalogRoot()
    expect(fs.existsSync(root)).toBe(true)
  })
})

describe("buildSyntheticPlugin: no-op path", () => {
  it("does nothing when all arrays are empty", async () => {
    const ctx = makeCtx()
    await buildSyntheticPlugin(ctx as any, makeProfile({}))
    expect(ctx.data.syntheticPluginPath).toBeUndefined()
  })
})

describe("buildSyntheticPlugin: skill copy", () => {
  it("copies kody-live-marker skill into synthetic plugin dir", async () => {
    const ctx = makeCtx()
    await buildSyntheticPlugin(ctx as any, makeProfile({ skills: ["kody-live-marker"] }))
    const root = ctx.data.syntheticPluginPath as string
    expect(fs.existsSync(path.join(root, "skills", "kody-live-marker", "SKILL.md"))).toBe(true)
    const manifest = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf-8"))
    expect(manifest.skills).toEqual(["./skills/"])
    expect(manifest.name).toContain("kody-synth")
  })

  it("throws a clear error for unknown skill", async () => {
    const ctx = makeCtx()
    await expect(buildSyntheticPlugin(ctx as any, makeProfile({ skills: ["does-not-exist"] }))).rejects.toThrow(
      /skill not found in catalog: does-not-exist/,
    )
  })
})

describe("buildSyntheticPlugin: command copy", () => {
  it("copies kody-live-probe command", async () => {
    const ctx = makeCtx()
    await buildSyntheticPlugin(ctx as any, makeProfile({ commands: ["kody-live-probe"] }))
    const root = ctx.data.syntheticPluginPath as string
    expect(fs.existsSync(path.join(root, "commands", "kody-live-probe.md"))).toBe(true)
  })

  it("throws a clear error for unknown command", async () => {
    const ctx = makeCtx()
    await expect(buildSyntheticPlugin(ctx as any, makeProfile({ commands: ["does-not-exist"] }))).rejects.toThrow(
      /command not found in catalog: does-not-exist/,
    )
  })
})

describe("buildSyntheticPlugin: hook merge", () => {
  it("merges kody-live-trace hooks into one hooks.json", async () => {
    const ctx = makeCtx()
    await buildSyntheticPlugin(ctx as any, makeProfile({ hooks: ["kody-live-trace"] }))
    const root = ctx.data.syntheticPluginPath as string
    const merged = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf-8"))
    expect(Array.isArray(merged.hooks.PreToolUse)).toBe(true)
    expect(merged.hooks.PreToolUse.length).toBeGreaterThan(0)
  })

  it("throws a clear error for unknown hook", async () => {
    const ctx = makeCtx()
    await expect(buildSyntheticPlugin(ctx as any, makeProfile({ hooks: ["does-not-exist"] }))).rejects.toThrow(
      /hook not found in catalog: does-not-exist/,
    )
  })
})

describe("buildSyntheticPlugin: all features together", () => {
  it("assembles skills + commands + hooks into one plugin", async () => {
    const ctx = makeCtx()
    await buildSyntheticPlugin(
      ctx as any,
      makeProfile({
        skills: ["kody-live-marker"],
        commands: ["kody-live-probe"],
        hooks: ["kody-live-trace"],
      }),
    )
    const root = ctx.data.syntheticPluginPath as string
    expect(fs.existsSync(path.join(root, "skills", "kody-live-marker", "SKILL.md"))).toBe(true)
    expect(fs.existsSync(path.join(root, "commands", "kody-live-probe.md"))).toBe(true)
    expect(fs.existsSync(path.join(root, "hooks", "hooks.json"))).toBe(true)
    const manifest = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf-8"))
    expect(manifest.skills).toEqual(["./skills/"])
    expect(manifest.commands).toEqual(["./commands/"])
  })
})
