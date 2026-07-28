import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/implementations/types.js"
import { buildSyntheticPlugin, getPluginsCatalogRoot } from "../../src/scripts/buildSyntheticPlugin.js"

function makeCtx(): Context {
  return {
    args: { issue: 1 },
    cwd: os.tmpdir(),
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
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
    await buildSyntheticPlugin(ctx, makeProfile({}))
    expect(ctx.data.syntheticPluginPath).toBeUndefined()
  })
})

describe("buildSyntheticPlugin: skill copy", () => {
  it("copies kody-live-marker skill into synthetic plugin dir", async () => {
    const ctx = makeCtx()
    await buildSyntheticPlugin(ctx, makeProfile({ skills: ["kody-live-marker"] }))
    const root = ctx.data.syntheticPluginPath as string
    expect(fs.existsSync(path.join(root, "skills", "kody-live-marker", "SKILL.md"))).toBe(true)
    const manifest = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf-8"))
    expect(manifest.skills).toEqual(["./skills/"])
    expect(manifest.name).toContain("kody-synth")
  })

  it("throws a clear error for unknown skill", async () => {
    const ctx = makeCtx()
    await expect(buildSyntheticPlugin(ctx, makeProfile({ skills: ["does-not-exist"] }))).rejects.toThrow(
      /skills entry 'does-not-exist' not found in implementation dir .* Store shared assets .* or catalog/,
    )
  })

  it("prefers an implementation-local skill over the catalog", async () => {
    const ctx = makeCtx()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-local-skill-"))
    try {
      const skillDir = path.join(tmp, "skills", "kody-live-marker")
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# local override\n")

      const profile = makeProfile({ skills: ["kody-live-marker"] })
      profile.dir = tmp
      await buildSyntheticPlugin(ctx, profile)

      const root = ctx.data.syntheticPluginPath as string
      const copied = fs.readFileSync(path.join(root, "skills", "kody-live-marker", "SKILL.md"), "utf-8")
      expect(copied).toBe("# local override\n")
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("loads an implementation-local skill that is not in the catalog", async () => {
    const ctx = makeCtx()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-local-skill-only-"))
    try {
      const skillDir = path.join(tmp, "skills", "exec-only-skill")
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# exec-only\n")

      const profile = makeProfile({ skills: ["exec-only-skill"] })
      profile.dir = tmp
      await buildSyntheticPlugin(ctx, profile)

      const root = ctx.data.syntheticPluginPath as string
      expect(fs.existsSync(path.join(root, "skills", "exec-only-skill", "SKILL.md"))).toBe(true)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("loads a Store-shared skill when the Implementation declares it", async () => {
    const ctx = makeCtx()
    const definitionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kody-shared-skill-"))
    try {
      const implementationDir = path.join(definitionsRoot, "implementations", "review")
      const skillDir = path.join(definitionsRoot, "shared", "skills", "shared-review-guidance")
      fs.mkdirSync(implementationDir, { recursive: true })
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# shared\n")

      const profile = makeProfile({ skills: ["shared-review-guidance"] })
      profile.dir = implementationDir
      await buildSyntheticPlugin(ctx, profile)

      const root = ctx.data.syntheticPluginPath as string
      expect(fs.readFileSync(path.join(root, "skills", "shared-review-guidance", "SKILL.md"), "utf-8")).toBe(
        "# shared\n",
      )
    } finally {
      fs.rmSync(definitionsRoot, { recursive: true, force: true })
    }
  })
})

describe("buildSyntheticPlugin: command copy", () => {
  it("copies kody-live-probe command", async () => {
    const ctx = makeCtx()
    await buildSyntheticPlugin(ctx, makeProfile({ commands: ["kody-live-probe"] }))
    const root = ctx.data.syntheticPluginPath as string
    expect(fs.existsSync(path.join(root, "commands", "kody-live-probe.md"))).toBe(true)
  })

  it("throws a clear error for unknown command", async () => {
    const ctx = makeCtx()
    await expect(buildSyntheticPlugin(ctx, makeProfile({ commands: ["does-not-exist"] }))).rejects.toThrow(
      /commands entry 'does-not-exist.md' not found in implementation dir .* or catalog/,
    )
  })
})

describe("buildSyntheticPlugin: hook merge", () => {
  it("merges kody-live-trace hooks into one hooks.json", async () => {
    const ctx = makeCtx()
    await buildSyntheticPlugin(ctx, makeProfile({ hooks: ["kody-live-trace"] }))
    const root = ctx.data.syntheticPluginPath as string
    const merged = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf-8"))
    expect(Array.isArray(merged.hooks.PreToolUse)).toBe(true)
    expect(merged.hooks.PreToolUse.length).toBeGreaterThan(0)
  })

  it("throws a clear error for unknown hook", async () => {
    const ctx = makeCtx()
    await expect(buildSyntheticPlugin(ctx, makeProfile({ hooks: ["does-not-exist"] }))).rejects.toThrow(
      /hooks entry 'does-not-exist.json' not found in implementation dir .* or catalog/,
    )
  })
})

describe("buildSyntheticPlugin: all features together", () => {
  it("assembles skills + commands + hooks into one plugin", async () => {
    const ctx = makeCtx()
    await buildSyntheticPlugin(
      ctx,
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
