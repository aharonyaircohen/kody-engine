import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { loadProfile } from "../../src/profile.js"
import { persistArtifacts } from "../../src/scripts/persistArtifacts.js"
import { resolveArtifacts } from "../../src/scripts/resolveArtifacts.js"
import { type Action, emptyState, parseStateComment, reduce, renderStateComment, setArtifact } from "../../src/state.js"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-artifacts-"))
}

function writeProfile(dir: string, profile: unknown): string {
  const p = path.join(dir, "profile.json")
  fs.writeFileSync(p, JSON.stringify(profile, null, 2))
  return p
}

const MIN_PROFILE = {
  name: "demo",
  role: "primitive",
  describe: "demo",
  inputs: [{ name: "issue", flag: "--issue", type: "int", describe: "" }],
  claudeCode: {
    model: "inherit",
    permissionMode: "acceptEdits",
    maxTurns: null,
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
}

function mkCtx(data: Record<string, unknown> = {}): Context {
  return {
    args: {},
    cwd: process.cwd(),
    config: {
      quality: { typecheck: "", lint: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/sonnet" },
    },
    data,
    output: { exitCode: 0 },
  }
}

describe("state: artifacts", () => {
  it("emptyState includes an empty artifacts map", () => {
    expect(emptyState().artifacts).toEqual({})
  })

  it("setArtifact is immutable and adds to the artifacts map", () => {
    const s1 = emptyState()
    const s2 = setArtifact(s1, "plan", {
      format: "markdown",
      producedBy: "plan",
      createdAt: "t",
      content: "# plan\n- x",
    })
    expect(s1.artifacts).toEqual({})
    expect(s2.artifacts.plan?.content).toBe("# plan\n- x")
  })

  it("reduce preserves artifacts across actions", () => {
    let s = setArtifact(emptyState(), "plan", {
      format: "markdown",
      producedBy: "plan",
      createdAt: "t",
      content: "body",
    })
    const action: Action = { type: "RUN_COMPLETED", payload: {}, timestamp: "t2" }
    s = reduce(s, "run", action)
    expect(s.artifacts.plan?.content).toBe("body")
  })

  it("renderStateComment / parseStateComment round-trip artifacts", () => {
    const s1 = setArtifact(emptyState(), "plan", {
      format: "markdown",
      producedBy: "plan",
      createdAt: "2026-04-20T00:00:00Z",
      content: "# plan\n- change x",
    })
    const body = renderStateComment(s1)
    expect(body).toContain("**Artifacts:** `plan`")
    const s2 = parseStateComment(body)
    expect(s2.artifacts.plan?.content).toBe("# plan\n- change x")
    expect(s2.artifacts.plan?.producedBy).toBe("plan")
  })
})

describe("profile: input/output artifact parsing", () => {
  it("parses output.artifacts declaration", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, {
      ...MIN_PROFILE,
      output: { artifacts: [{ name: "plan", format: "markdown", from: "prSummary" }] },
    })
    const profile = loadProfile(p)
    expect(profile.outputArtifacts).toEqual([{ name: "plan", format: "markdown", from: "prSummary" }])
  })

  it("parses input.artifacts declaration (string and object forms)", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, {
      ...MIN_PROFILE,
      input: { artifacts: ["plan", { name: "review", required: true }] },
    })
    const profile = loadProfile(p)
    expect(profile.inputArtifacts).toEqual([{ name: "plan" }, { name: "review", required: true }])
  })

  it("defaults to empty arrays when not declared", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, MIN_PROFILE)
    const profile = loadProfile(p)
    expect(profile.inputArtifacts).toEqual([])
    expect(profile.outputArtifacts).toEqual([])
  })
})

describe("persistArtifacts postflight", () => {
  it("writes declared outputs into taskState.artifacts", async () => {
    const dir = tmpDir()
    const p = writeProfile(dir, {
      ...MIN_PROFILE,
      output: { artifacts: [{ name: "plan", format: "markdown", from: "prSummary" }] },
    })
    const profile = loadProfile(p) as Profile
    const ctx = mkCtx({ taskState: emptyState(), prSummary: "# the plan\n- do x" })

    await persistArtifacts(ctx, profile, null)

    const state = ctx.data.taskState as ReturnType<typeof emptyState>
    expect(state.artifacts.plan?.content).toBe("# the plan\n- do x")
    expect(state.artifacts.plan?.producedBy).toBe("demo")
    expect(state.artifacts.plan?.format).toBe("markdown")
  })

  it("skips artifacts whose source field is missing", async () => {
    const dir = tmpDir()
    const p = writeProfile(dir, {
      ...MIN_PROFILE,
      output: { artifacts: [{ name: "plan", format: "markdown", from: "prSummary" }] },
    })
    const profile = loadProfile(p) as Profile
    const ctx = mkCtx({ taskState: emptyState() })

    await persistArtifacts(ctx, profile, null)

    const state = ctx.data.taskState as ReturnType<typeof emptyState>
    expect(state.artifacts).toEqual({})
  })

  it("is a no-op when profile declares no outputs", async () => {
    const dir = tmpDir()
    const profile = loadProfile(writeProfile(dir, MIN_PROFILE)) as Profile
    const ctx = mkCtx({ taskState: emptyState(), prSummary: "unused" })
    await persistArtifacts(ctx, profile, null)
    expect((ctx.data.taskState as ReturnType<typeof emptyState>).artifacts).toEqual({})
  })
})

describe("resolveArtifacts preflight", () => {
  it("loads artifacts from state into ctx.data.artifacts", async () => {
    const dir = tmpDir()
    const p = writeProfile(dir, {
      ...MIN_PROFILE,
      input: { artifacts: ["plan"] },
    })
    const profile = loadProfile(p) as Profile
    const state = setArtifact(emptyState(), "plan", {
      format: "markdown",
      producedBy: "plan",
      createdAt: "t",
      content: "# plan body",
    })
    const ctx = mkCtx({ taskState: state })

    await resolveArtifacts(ctx, profile)

    expect(ctx.data.artifacts).toEqual({ plan: "# plan body" })
    expect(ctx.skipAgent).toBeFalsy()
  })

  it("sets skipAgent when a required artifact is missing", async () => {
    const dir = tmpDir()
    const p = writeProfile(dir, {
      ...MIN_PROFILE,
      input: { artifacts: [{ name: "plan", required: true }] },
    })
    const profile = loadProfile(p) as Profile
    const ctx = mkCtx({ taskState: emptyState() })

    await resolveArtifacts(ctx, profile)

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(64)
    expect(ctx.output.reason).toMatch(/plan/)
  })

  it("leaves ctx.data.artifacts empty + continues when optional artifact missing", async () => {
    const dir = tmpDir()
    const p = writeProfile(dir, {
      ...MIN_PROFILE,
      input: { artifacts: [{ name: "plan", required: false }] },
    })
    const profile = loadProfile(p) as Profile
    const ctx = mkCtx({ taskState: emptyState() })

    await resolveArtifacts(ctx, profile)

    expect(ctx.data.artifacts).toEqual({})
    expect(ctx.skipAgent).toBeFalsy()
  })

  it("is a no-op when profile declares no inputs", async () => {
    const dir = tmpDir()
    const profile = loadProfile(writeProfile(dir, MIN_PROFILE)) as Profile
    const ctx = mkCtx({ taskState: emptyState() })
    await resolveArtifacts(ctx, profile)
    expect(ctx.data.artifacts).toBeUndefined()
  })
})
