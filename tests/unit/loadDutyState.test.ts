import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { loadDutyState } from "../../src/scripts/loadDutyState.js"

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "load-duty-state-"))
  fs.mkdirSync(path.join(tmp, ".kody", "duties"), { recursive: true })
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
    name: "locked-duty",
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

describe("loadDutyState", () => {
  it("loads state json into ctx.data for the prompt + writeJobStateFile", async () => {
    const ctx = ctxFor()
    await loadDutyState(ctx, profileFor(), {})
    expect(ctx.data.jobSlug).toBe("locked-duty")
    expect(typeof ctx.data.jobStateJson).toBe("string")
    expect(ctx.data.jobState).toBeTruthy()
  })

  it("locks the toolbox + forces enableSubmitTool when dutyTools declared", async () => {
    const ctx = ctxFor()
    const profile = profileFor({}, { dutyTools: ["read_check_runs", "ensure_issue"], mentions: ["alice"] })
    await loadDutyState(ctx, profile, {})
    expect(profile.claudeCode.tools).toEqual([
      "mcp__kody-duty__read_check_runs",
      "mcp__kody-duty__ensure_issue",
      "mcp__kody-submit__submit_state",
    ])
    expect(profile.claudeCode.enableSubmitTool).toBe(true)
    expect(ctx.data.dutyTools).toEqual(["read_check_runs", "ensure_issue"])
    expect(ctx.data.mentions).toBe("@alice")
    expect(ctx.data.dutyOperatorMention).toBe("@alice")
  })

  it("leaves tools untouched for a non-locked duty (no dutyTools)", async () => {
    const ctx = ctxFor()
    const profile = profileFor({ tools: ["Bash", "Read"] })
    await loadDutyState(ctx, profile, {})
    expect(profile.claudeCode.tools).toEqual(["Bash", "Read"])
    expect(profile.claudeCode.enableSubmitTool).toBe(false)
    expect(ctx.data.mentions).toBe("")
  })
})
