import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { loadCapabilityState } from "../../src/scripts/loadCapabilityState.js"

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "load-capability-state-"))
  fs.mkdirSync(path.join(tmp, ".kody", "capabilities"), { recursive: true })
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function ctxFor(): Context {
  const config: KodyConfig = {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "o", repo: "r" },
    agent: { model: "anthropic/test" },
    jobs: { stateBackend: "local-file" },
  }
  return { args: {}, cwd: tmp, config, data: {}, output: { exitCode: 0 } }
}

function profileFor(over: Partial<Profile["claudeCode"]> = {}, extra: Partial<Profile> = {}): Profile {
  return {
    name: "locked-capability",
    role: "primitive",
    describe: "x",
    claudeCode: {
      model: "inherit",
      permissionMode: "acceptEdits",
      tools: [],
      hooks: [],
      skills: [],
      commands: [],
      subagents: [],
      plugins: [],
      mcpServers: [],
      enableSubmitTool: false,
      ...over,
    },
    ...extra,
  } as unknown as Profile
}

describe("loadCapabilityState", () => {
  it("loads state json into ctx.data for the prompt + writeJobStateFile", async () => {
    const ctx = ctxFor()
    await loadCapabilityState(ctx, profileFor(), {})
    expect(ctx.data.jobSlug).toBe("locked-capability")
    expect(typeof ctx.data.jobStateJson).toBe("string")
    expect(ctx.data.jobState).toBeTruthy()
  })

  it("locks the toolbox + forces enableSubmitTool when capabilityTools declared", async () => {
    const ctx = ctxFor()
    const profile = profileFor({}, { capabilityTools: ["read_check_runs", "ensure_issue"], mentions: ["alice"] })
    await loadCapabilityState(ctx, profile, {})
    expect(profile.claudeCode.tools).toEqual([
      "mcp__kody-capability__read_check_runs",
      "mcp__kody-capability__ensure_issue",
      "mcp__kody-submit__submit_state",
    ])
    expect(profile.claudeCode.enableSubmitTool).toBe(true)
    expect(ctx.data.capabilityTools).toEqual(["read_check_runs", "ensure_issue"])
    expect(ctx.data.mentions).toBe("@alice")
    expect(ctx.data.capabilityOperatorMention).toBe("@alice")
  })

  it("append mode keeps shell tools and adds declared capability MCP tools", async () => {
    const ctx = ctxFor()
    const profile = profileFor(
      { tools: ["Bash", "Read"], enableSubmitTool: false },
      {
        capabilityTools: ["start_capability"],
        capabilityToolMode: "append",
        mentions: ["alice"],
      },
    )
    await loadCapabilityState(ctx, profile, {})
    expect(profile.claudeCode.tools).toEqual(["Bash", "Read", "mcp__kody-capability__start_capability"])
    expect(profile.claudeCode.enableSubmitTool).toBe(false)
    expect(ctx.data.capabilityTools).toEqual(["start_capability"])
    expect(ctx.data.capabilityToolMode).toBe("append")
    expect(ctx.data.capabilityOperatorMention).toBe("@alice")
  })

  it("leaves tools untouched for a non-locked capability (no capabilityTools)", async () => {
    const ctx = ctxFor()
    const profile = profileFor({ tools: ["Bash", "Read"] })
    await loadCapabilityState(ctx, profile, {})
    expect(profile.claudeCode.tools).toEqual(["Bash", "Read"])
    expect(profile.claudeCode.enableSubmitTool).toBe(false)
    expect(ctx.data.mentions).toBe("")
  })
})

describe("loadCapabilityState capability-noun aliases (Phase 1 rename)", () => {
  it("populates capabilitySlug from profile.name, mirroring jobSlug", async () => {
    const ctx = ctxFor()
    await loadCapabilityState(ctx, profileFor(), {})
    expect(ctx.data.capabilitySlug).toBe("locked-capability")
    expect(ctx.data.jobSlug).toBe("locked-capability")
  })

  it("populates capabilityTitle from profile.describe", async () => {
    const ctx = ctxFor()
    const profile = profileFor({}, { describe: "Folder Capability Title" })
    await loadCapabilityState(ctx, profile, {})
    expect(ctx.data.capabilityTitle).toBe("Folder Capability Title")
  })

  it("populates executableSlug from profile.executable when set, else profile.name", async () => {
    const ctx = ctxFor()
    const profile = profileFor({}, { executable: "capability-tick-scripted" })
    await loadCapabilityState(ctx, profile, {})
    expect(ctx.data.executableSlug).toBe("capability-tick-scripted")
  })

  it("populates agentSlug from profile.agent when set", async () => {
    const ctx = ctxFor()
    const profile = profileFor({}, { agent: "kody" })
    await loadCapabilityState(ctx, profile, {})
    expect(ctx.data.agentSlug).toBe("kody")
  })

  it("populates capabilitySchedule from runtime jobSchedule", async () => {
    const ctx = ctxFor()
    ctx.data.jobSchedule = "*/5 * * * *"
    await loadCapabilityState(ctx, profileFor(), {})
    expect(ctx.data.capabilitySchedule).toBe("*/5 * * * *")
  })

  it("renders empty capabilitySchedule when no runtime schedule exists", async () => {
    const ctx = ctxFor()
    await loadCapabilityState(ctx, profileFor(), {})
    expect(ctx.data.capabilitySchedule).toBe("")
  })
})
