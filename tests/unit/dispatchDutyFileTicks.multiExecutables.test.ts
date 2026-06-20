import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/executables/types.js"
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

import { dispatchDutyFileTicks } from "../../src/scripts/dispatchDutyFileTicks.js"

let tmp: string

beforeEach(() => {
  vi.stubEnv("KODY_COMPANY_STORE", "0")
  resetCompanyStoreCacheForTests()
  ghMock.mockReset()
  ghMock.mockReturnValue("https://github.com/o/r/issues/777")
  runJobMock.mockReset()
  runJobMock.mockResolvedValue({ exitCode: 0 })
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-duty-multi-"))
  fs.mkdirSync(path.join(tmp, ".kody", "duties"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  vi.unstubAllEnvs()
  resetCompanyStoreCacheForTests()
  vi.clearAllMocks()
})

function writeDuty(slug: string, profile: Record<string, unknown>, body = "# Duty\n\nDo the work."): void {
  const dir = path.join(tmp, ".kody", "duties", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "duty.md"), body)
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

describe("dispatchDutyFileTicks multi-executable duties", () => {
  it("creates a task issue and runs task-jobs for a duty with executables", async () => {
    writeDuty("daily-check", { every: "1h", staff: "kody", executables: ["plan-verify", "probe-skill"] })

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    expect(ghMock).toHaveBeenCalledTimes(1)
    const [args, options] = ghMock.mock.calls[0]!
    expect(args).toEqual(["issue", "create", "--title", "Duty daily-check - multi-executable task", "--body-file", "-"])
    expect(options.cwd).toBe(tmp)

    const specs = parseTaskJobSpecs(options.input)
    expect(specs).toEqual([
      {
        executable: "plan-verify",
        duty: "daily-check",
        staff: "kody",
        reason: "Duty `daily-check` slice for `plan-verify`.",
        flavor: "scheduled",
        schedule: "1h",
      },
      {
        executable: "probe-skill",
        duty: "daily-check",
        staff: "kody",
        reason: "Duty `daily-check` slice for `probe-skill`.",
        flavor: "scheduled",
        schedule: "1h",
      },
    ])

    expect(runJobMock).toHaveBeenCalledTimes(1)
    expect(runJobMock.mock.calls[0]![0]).toMatchObject({
      duty: "daily-check",
      executable: "task-jobs",
      persona: "kody",
      schedule: "1h",
      cliArgs: { issue: 777 },
      flavor: "scheduled",
    })
    expect(runJobMock.mock.calls[0]![1]).toMatchObject({ cwd: tmp })
    expect(runJobMock.mock.calls[0]![1].chain).not.toBe(false)
  })

  it("records the created task issue on the duty state file", async () => {
    writeDuty("daily-check", { every: "1h", staff: "kody", executables: ["plan-verify"] })

    await dispatchDutyFileTicks(ctxFor(), PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    const state = JSON.parse(fs.readFileSync(path.join(tmp, ".kody", "duties", "daily-check/state.json"), "utf-8"))
    expect(state.data.lastTaskIssue).toBe(777)
    expect(state.data.lastTaskUrl).toBe("https://github.com/o/r/issues/777")
    expect(typeof state.data.lastFiredAt).toBe("string")
  })
})
