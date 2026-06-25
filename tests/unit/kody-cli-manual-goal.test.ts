import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runJob: vi.fn(async (..._args: unknown[]) => ({ exitCode: 0 })),
}))

vi.mock("../../src/job.js", () => ({
  mintInstantJob: (dispatch: unknown) => ({ dispatch }),
  mintScheduledJob: (dispatch: unknown) => ({ dispatch }),
  runJob: mocks.runJob,
}))

vi.mock("../../src/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/registry.js")>()
  return {
    ...actual,
    resolveAgentResponsibilityAction: vi.fn((action: string) =>
      action === "goal-manager"
        ? {
            action: "goal-manager",
            agentResponsibility: "goal-manager",
            agentAction: "goal-manager",
            cliArgs: {},
            source: "builtin",
          }
        : null,
    ),
  }
})

import { runCi } from "../../src/kody-cli.js"

const previousEnv: Record<string, string | undefined> = {}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-cli-goal-"))
}

function writeEvent(body: unknown): string {
  const dir = tmpDir()
  const file = path.join(dir, "event.json")
  fs.writeFileSync(file, JSON.stringify(body))
  return file
}

function writeConfig(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "kody.config.json"),
    JSON.stringify({
      quality: { typecheck: "", lint: "", format: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "owner", repo: "repo" },
      agent: { model: "anthropic/claude-haiku-4-5-20251001" },
    }),
  )
}

function writeScheduledAgentAction(dir: string, name: string): void {
  const executableDir = path.join(dir, ".kody", "agent-actions", name)
  fs.mkdirSync(executableDir, { recursive: true })
  fs.writeFileSync(
    path.join(executableDir, "profile.json"),
    JSON.stringify({
      name,
      role: "watch",
      kind: "scheduled",
      schedule: "*/5 * * * *",
      scripts: { preflight: [], postflight: [] },
    }),
  )
}

afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  mocks.runJob.mockClear()
  vi.clearAllMocks()
})

describe("kody-cli manual goal dispatch", () => {
  it("passes workflow message as goal id for goal-manager one-shot runs", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    previousEnv.GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME
    previousEnv.GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      inputs: { agentAction: "goal-manager", message: "weekly-docs" },
    })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).toHaveBeenCalledTimes(1)
    expect(mocks.runJob.mock.calls[0]?.[0]).toMatchObject({
      action: "goal-manager",
      agentResponsibility: "goal-manager",
      agentAction: "goal-manager",
      cliArgs: { goal: "weekly-docs" },
      flavor: "instant",
      force: true,
    })
  })

  it("rejects goal-manager one-shot runs without a message goal id", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    previousEnv.GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME
    previousEnv.GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      inputs: { agentAction: "goal-manager" },
    })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(64)
    expect(mocks.runJob).not.toHaveBeenCalled()
  })

  it("runs scheduled watch agentActions from manual workflow dispatch", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    writeScheduledAgentAction(dir, "goal-scheduler")
    previousEnv.GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME
    previousEnv.GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      inputs: { agentAction: "goal-scheduler" },
    })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).toHaveBeenCalledTimes(1)
    expect(mocks.runJob.mock.calls[0]?.[0]).toMatchObject({
      action: "goal-scheduler",
      agentResponsibility: "goal-scheduler",
      agentAction: "goal-scheduler",
      cliArgs: {},
      flavor: "instant",
      force: true,
    })
  })
it("chains scheduled goal-scheduler ticks from schedule events", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    writeScheduledAgentAction(dir, "goal-scheduler")
    previousEnv.GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME
    previousEnv.GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "schedule"
    process.env.GITHUB_EVENT_PATH = writeEvent({ schedule: "*/5 * * * *" })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).toHaveBeenCalledTimes(1)
    expect(mocks.runJob.mock.calls[0]?.[0]).toMatchObject({
      dispatch: {
        action: "goal-scheduler",
        agentResponsibility: "goal-scheduler",
        agentAction: "goal-scheduler",
        cliArgs: {},
      },
    })
    expect(mocks.runJob.mock.calls[0]?.[1]).toMatchObject({
      cwd: dir,
      chain: true,
    })
  })

  it("checks scheduled watches when workflow event has no direct action", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    writeScheduledAgentAction(dir, "goal-scheduler")
    previousEnv.GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME
    previousEnv.GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "plain comment", user: { login: "alice", type: "User" }, author_association: "OWNER" },
      issue: { number: 42 },
    })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).toHaveBeenCalledTimes(1)
    expect(mocks.runJob.mock.calls[0]?.[0]).toMatchObject({
      dispatch: {
        action: "goal-scheduler",
        agentResponsibility: "goal-scheduler",
        agentAction: "goal-scheduler",
        cliArgs: {},
      },
    })
    expect(mocks.runJob.mock.calls[0]?.[1]).toMatchObject({
      cwd: dir,
      chain: true,
    })
  })
})
