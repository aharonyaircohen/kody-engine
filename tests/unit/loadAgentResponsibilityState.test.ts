import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/agent-actions/types.js"
import { loadAgentResponsibilityState } from "../../src/scripts/loadAgentResponsibilityState.js"

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "load-agentResponsibility-state-"))
  fs.mkdirSync(path.join(tmp, ".kody", "agent-responsibilities"), { recursive: true })
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
    name: "locked-agentResponsibility",
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

describe("loadAgentResponsibilityState", () => {
  it("loads state json into ctx.data for the prompt + writeJobStateFile", async () => {
    const ctx = ctxFor()
    await loadAgentResponsibilityState(ctx, profileFor(), {})
    expect(ctx.data.jobSlug).toBe("locked-agentResponsibility")
    expect(typeof ctx.data.jobStateJson).toBe("string")
    expect(ctx.data.jobState).toBeTruthy()
  })

  it("locks the toolbox + forces enableSubmitTool when agentResponsibilityTools declared", async () => {
    const ctx = ctxFor()
    const profile = profileFor({}, { agentResponsibilityTools: ["read_check_runs", "ensure_issue"], mentions: ["alice"] })
    await loadAgentResponsibilityState(ctx, profile, {})
    expect(profile.claudeCode.tools).toEqual([
      "mcp__kody-agent-responsibility__read_check_runs",
      "mcp__kody-agent-responsibility__ensure_issue",
      "mcp__kody-submit__submit_state",
    ])
    expect(profile.claudeCode.enableSubmitTool).toBe(true)
    expect(ctx.data.agentResponsibilityTools).toEqual(["read_check_runs", "ensure_issue"])
    expect(ctx.data.mentions).toBe("@alice")
    expect(ctx.data.agentResponsibilityOperatorMention).toBe("@alice")
  })

  it("leaves tools untouched for a non-locked agentResponsibility (no agentResponsibilityTools)", async () => {
    const ctx = ctxFor()
    const profile = profileFor({ tools: ["Bash", "Read"] })
    await loadAgentResponsibilityState(ctx, profile, {})
    expect(profile.claudeCode.tools).toEqual(["Bash", "Read"])
    expect(profile.claudeCode.enableSubmitTool).toBe(false)
    expect(ctx.data.mentions).toBe("")
  })
})

describe("loadAgentResponsibilityState agentResponsibility-noun aliases (Phase 1 rename)", () => {
  it("populates agentResponsibilitySlug from profile.name, mirroring jobSlug", async () => {
    const ctx = ctxFor()
    await loadAgentResponsibilityState(ctx, profileFor(), {})
    expect(ctx.data.agentResponsibilitySlug).toBe("locked-agentResponsibility")
    expect(ctx.data.jobSlug).toBe("locked-agentResponsibility")
  })

  it("populates agentResponsibilityTitle from profile.describe", async () => {
    const ctx = ctxFor()
    const profile = profileFor({}, { describe: "Folder AgentResponsibility Title" })
    await loadAgentResponsibilityState(ctx, profile, {})
    expect(ctx.data.agentResponsibilityTitle).toBe("Folder AgentResponsibility Title")
  })

  it("populates agentActionSlug from profile.agentAction when set, else profile.name", async () => {
    const ctx = ctxFor()
    const profile = profileFor({}, { agentAction: "agent-responsibility-tick-scripted" })
    await loadAgentResponsibilityState(ctx, profile, {})
    expect(ctx.data.agentActionSlug).toBe("agent-responsibility-tick-scripted")
  })

  it("populates agentSlug from profile.agent when set", async () => {
    const ctx = ctxFor()
    const profile = profileFor({}, { agent: "kody" })
    await loadAgentResponsibilityState(ctx, profile, {})
    expect(ctx.data.agentSlug).toBe("kody")
  })

  it("populates agentResponsibilitySchedule from profile.every (new cadence string), or profile.schedule fallback", async () => {
    const ctx = ctxFor()
    const profile = profileFor({}, { every: "15m" })
    await loadAgentResponsibilityState(ctx, profile, {})
    expect(ctx.data.agentResponsibilitySchedule).toBe("15m")
  })

  it("falls back to profile.schedule when profile.every is absent (cron-style)", async () => {
    const ctx = ctxFor()
    const profile = profileFor({}, { schedule: "*/5 * * * *" })
    await loadAgentResponsibilityState(ctx, profile, {})
    expect(ctx.data.agentResponsibilitySchedule).toBe("*/5 * * * *")
  })

  it("renders empty agentResponsibilitySchedule for an on-demand agentResponsibility (no every/schedule)", async () => {
    const ctx = ctxFor()
    await loadAgentResponsibilityState(ctx, profileFor(), {})
    expect(ctx.data.agentResponsibilitySchedule).toBe("")
  })
})
