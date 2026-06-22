import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Context, Profile } from "../../src/agent-actions/types.js"
import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import type { KodyConfig } from "../../src/config.js"
import { parseTaskJobSpecs } from "../../src/scripts/planTaskJobs.js"

const ghMock = vi.hoisted(() => vi.fn())
const runJobMock = vi.hoisted(() => vi.fn())

vi.mock("../../src/issue.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/issue.js")>("../../src/issue.js")
  return { ...actual, gh: ghMock }
})

vi.mock("../../src/job.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/job.js")>("../../src/job.js")
  return { ...actual, runJob: runJobMock }
})

import { dispatchAgentResponsibilityFileTicks } from "../../src/scripts/dispatchAgentResponsibilityFileTicks.js"

let tmp: string

beforeEach(() => {
  vi.stubEnv("KODY_COMPANY_STORE", "0")
  resetCompanyStoreCacheForTests()
  ghMock.mockReset()
  ghMock.mockReturnValue("https://github.com/o/r/issues/777")
  runJobMock.mockReset()
  runJobMock.mockResolvedValue({ exitCode: 0 })
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-agentResponsibility-multi-"))
  fs.mkdirSync(path.join(tmp, ".kody", "agent-responsibilities"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  vi.unstubAllEnvs()
  resetCompanyStoreCacheForTests()
  vi.clearAllMocks()
})

function writeAgentResponsibility(
  slug: string,
  profile: Record<string, unknown>,
  body = "# AgentResponsibility\n\nDo the work.",
): void {
  const dir = path.join(tmp, ".kody", "agent-responsibilities", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "agent-responsibility.md"), body)
}

function ctxFor(): Context {
  const config: KodyConfig = {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "o", repo: "r" },
    agent: { model: "anthropic/test" },
    jobs: { stateBackend: "local-file" },
  }
  return {
    args: {},
    cwd: tmp,
    config,
    data: {},
    output: { exitCode: 0 },
  }
}

const PROFILE = {} as unknown as Profile

describe("dispatchAgentResponsibilityFileTicks multi-agentAction agentResponsibilities", () => {
  it("creates a task issue and runs task-jobs for a agentResponsibility with agentActions", async () => {
    writeAgentResponsibility("daily-check", {
      every: "1h",
      agent: "kody",
      agentActions: ["plan-verify", "probe-skill"],
    })

    const ctx = ctxFor()
    await dispatchAgentResponsibilityFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/agent-responsibilities",
      targetAgentAction: "agent-responsibility-tick",
      slugArg: "agentResponsibility",
    })

    expect(ghMock).toHaveBeenCalledTimes(1)
    const [args, options] = ghMock.mock.calls[0]!
    expect(args).toEqual([
      "issue",
      "create",
      "--title",
      "AgentResponsibility daily-check - multi-agentAction task",
      "--body-file",
      "-",
    ])
    expect(options.cwd).toBe(tmp)

    const specs = parseTaskJobSpecs(options.input)
    expect(specs).toEqual([
      {
        agentAction: "plan-verify",
        agentResponsibility: "daily-check",
        agent: "kody",
        reason: "AgentResponsibility `daily-check` slice for `plan-verify`.",
        flavor: "scheduled",
        schedule: "1h",
      },
      {
        agentAction: "probe-skill",
        agentResponsibility: "daily-check",
        agent: "kody",
        reason: "AgentResponsibility `daily-check` slice for `probe-skill`.",
        flavor: "scheduled",
        schedule: "1h",
      },
    ])

    expect(runJobMock).toHaveBeenCalledTimes(1)
    expect(runJobMock.mock.calls[0]![0]).toMatchObject({
      agentResponsibility: "daily-check",
      agentAction: "task-jobs",
      agent: "kody",
      schedule: "1h",
      cliArgs: { issue: 777 },
      flavor: "scheduled",
    })
    expect(runJobMock.mock.calls[0]![1]).toMatchObject({ cwd: tmp })
    expect(runJobMock.mock.calls[0]![1].chain).not.toBe(false)
  })

  it("records the created task issue on the agentResponsibility state file", async () => {
    writeAgentResponsibility("daily-check", { every: "1h", agent: "kody", agentActions: ["plan-verify"] })

    await dispatchAgentResponsibilityFileTicks(ctxFor(), PROFILE, {
      jobsDir: ".kody/agent-responsibilities",
      targetAgentAction: "agent-responsibility-tick",
      slugArg: "agentResponsibility",
    })

    const state = JSON.parse(
      fs.readFileSync(path.join(tmp, ".kody", "agent-responsibilities", "daily-check/state.json"), "utf-8"),
    )
    expect(state.data.lastTaskIssue).toBe(777)
    expect(state.data.lastTaskUrl).toBe("https://github.com/o/r/issues/777")
    expect(typeof state.data.lastFiredAt).toBe("string")
  })
})
