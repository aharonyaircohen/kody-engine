import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runJob: vi.fn(async (..._args: unknown[]) => ({ exitCode: 0 })),
  readWorkflowDefinition: vi.fn(),
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
    resolveCapabilityAction: vi.fn((action: string, projectCapabilitiesRoot?: string) =>
      action === "goal-manager"
        ? {
            action: "goal-manager",
            capability: "goal-manager",

            cliArgs: {},
            source: "builtin",
          }
        : actual.resolveCapabilityAction(action, projectCapabilitiesRoot),
    ),
  }
})

vi.mock("../../src/workflowDefinitions.js", () => ({
  readWorkflowDefinition: mocks.readWorkflowDefinition,
}))

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

function writeScheduledImplementation(dir: string, name: string): void {
  const implementationDir = path.join(dir, ".kody-engine", "definitions", "capabilities", name)
  fs.mkdirSync(implementationDir, { recursive: true })
  fs.writeFileSync(
    path.join(implementationDir, "profile.json"),
    JSON.stringify({
      name,
      internal: true,
      role: "watch",
      kind: "scheduled",
      schedule: "*/5 * * * *",
      scripts: { preflight: [], postflight: [] },
    }),
  )
  fs.writeFileSync(path.join(implementationDir, "capability.md"), `# ${name}\n`)
}

function writePublicCapability(dir: string, name: string, inputs: Array<Record<string, unknown>> = []): void {
  const capabilityDir = path.join(dir, ".kody-engine", "definitions", "capabilities", name)
  fs.mkdirSync(capabilityDir, { recursive: true })
  fs.writeFileSync(
    path.join(capabilityDir, "profile.json"),
    JSON.stringify({
      name,
      role: "primitive",
      kind: "oneshot",
      action: name,
      implementations: [name],
      inputs,
      scripts: { preflight: [], postflight: [] },
    }),
  )
  fs.writeFileSync(path.join(capabilityDir, "capability.md"), `# ${name}\n`)
}

afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  mocks.runJob.mockClear()
  mocks.readWorkflowDefinition.mockReset()
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
      inputs: { capability: "goal-manager", message: "weekly-docs" },
    })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).toHaveBeenCalledTimes(1)
    expect(mocks.runJob.mock.calls[0]?.[0]).toMatchObject({
      action: "goal-manager",
      capability: "goal-manager",

      cliArgs: { goal: "weekly-docs" },
      flavor: "instant",
      force: true,
    })
  })

  it("passes run request target id for runner goal-manager runs", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    previousEnv.KODY_RUN_REQUEST_JSON = process.env.KODY_RUN_REQUEST_JSON
    process.env.KODY_RUN_REQUEST_JSON = JSON.stringify({
      target: { type: "goal", id: "weekly-docs" },
      intent: "manage",
      source: "dashboard",
    })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).toHaveBeenCalledTimes(1)
    expect(mocks.runJob.mock.calls[0]?.[0]).toMatchObject({
      action: "goal-manager",
      capability: "goal-manager",

      cliArgs: { goal: "weekly-docs" },
      flavor: "instant",
      force: true,
    })
  })

  it("passes a workflow run id from the runner request into durable workflow execution", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    previousEnv.KODY_RUN_REQUEST_JSON = process.env.KODY_RUN_REQUEST_JSON
    process.env.KODY_RUN_REQUEST_JSON = JSON.stringify({
      target: { type: "workflow", id: "pilot-flow" },
      intent: "run",
      source: "dashboard",
      input: { runId: "pilot-run-1" },
    })
    mocks.readWorkflowDefinition.mockReturnValue({
      version: 1,
      name: "Pilot flow",
      capabilities: ["inspect"],
    })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).toHaveBeenCalledTimes(1)
    expect(mocks.runJob.mock.calls[0]?.[0]).toMatchObject({
      workflow: "pilot-flow",
      workflowRunId: "pilot-run-1",
      cliArgs: {},
      flavor: "instant",
      force: true,
    })
  })

  it("keeps legacy env action/message as a compatibility fallback", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    previousEnv.KODY_FORCE_ACTION = process.env.KODY_FORCE_ACTION
    previousEnv.KODY_FORCE_MESSAGE = process.env.KODY_FORCE_MESSAGE
    process.env.KODY_FORCE_ACTION = "goal-manager"
    process.env.KODY_FORCE_MESSAGE = "weekly-docs"

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).toHaveBeenCalledTimes(1)
    expect(mocks.runJob.mock.calls[0]?.[0]).toMatchObject({
      action: "goal-manager",
      capability: "goal-manager",

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
      inputs: { capability: "goal-manager" },
    })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(64)
    expect(mocks.runJob).not.toHaveBeenCalled()
  })

  it("runs scheduled watch capabilities from manual workflow dispatch", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    previousEnv.GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME
    previousEnv.GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      inputs: { capability: "loop-scheduler" },
    })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).toHaveBeenCalledTimes(1)
    expect(mocks.runJob.mock.calls[0]?.[0]).toMatchObject({
      action: "loop-scheduler",
      capability: "loop-scheduler",

      cliArgs: {},
      flavor: "instant",
      force: true,
    })
  })

  it.skip("resolves a public capability from the selected consumer cwd", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    writePublicCapability(dir, "dispatch-due-loops")
    previousEnv.GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME
    previousEnv.GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      inputs: { capability: "dispatch-due-loops" },
    })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "dispatch-due-loops",
        capability: "dispatch-due-loops",
        flavor: "instant",
        force: true,
      }),
      expect.objectContaining({ cwd: dir }),
    )
  })

  it.skip("binds a workflow message to a capability's single text input", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    writePublicCapability(dir, "dispatch-due-loops", [
      {
        name: "loop",
        flag: "--loop",
        type: "string",
        required: false,
        description: "Loop to force",
      },
    ])
    previousEnv.GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME
    previousEnv.GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      inputs: {
        capability: "dispatch-due-loops",
        message: "knowledge-system-refresh",
      },
    })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "dispatch-due-loops",
        cliArgs: { loop: "knowledge-system-refresh" },
      }),
      expect.objectContaining({ cwd: dir }),
    )
  })

  it("runs stored workflows from manual workflow dispatch", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    previousEnv.GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME
    previousEnv.GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH
    previousEnv.ALL_SECRETS = process.env.ALL_SECRETS
    previousEnv.GH_TOKEN = process.env.GH_TOKEN
    previousEnv.GH_PAT = process.env.GH_PAT
    previousEnv.GITHUB_TOKEN = process.env.GITHUB_TOKEN
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      inputs: { capability: "web-release" },
    })
    delete process.env.GH_TOKEN
    delete process.env.GH_PAT
    delete process.env.GITHUB_TOKEN
    process.env.ALL_SECRETS = JSON.stringify({ GH_PAT: "secret-gh-token" })
    mocks.readWorkflowDefinition.mockImplementation(() => {
      expect(process.env.GH_TOKEN).toBe("secret-gh-token")
      return {
        version: 1,
        name: "Web release",
        capabilities: ["release-prepare"],
      }
    })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).toHaveBeenCalledTimes(1)
    expect(mocks.runJob.mock.calls[0]?.[0]).toMatchObject({
      workflow: "web-release",
      cliArgs: {},
      flavor: "instant",
      force: true,
    })
  })

  it("runs the local Loop scheduler from schedule events", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    previousEnv.GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME
    previousEnv.GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "schedule"
    process.env.GITHUB_EVENT_PATH = writeEvent({ schedule: "*/5 * * * *" })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).toHaveBeenCalledTimes(1)
    expect(mocks.runJob.mock.calls[0]?.[0]).toMatchObject({
      dispatch: {
        action: "loop-scheduler",
        capability: "loop-scheduler",

        cliArgs: {},
      },
    })
    expect(mocks.runJob.mock.calls[0]?.[1]).toMatchObject({
      cwd: dir,
      chain: false,
    })
  })

  it("does not check scheduled watches for issue comments with no direct action", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    writeScheduledImplementation(dir, "goal-scheduler")
    previousEnv.GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME
    previousEnv.GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "plain comment", user: { login: "alice", type: "User" }, author_association: "OWNER" },
      issue: { number: 42 },
    })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).not.toHaveBeenCalled()
  })

  it("does not check scheduled watches for pull_request events with no direct action", async () => {
    const dir = tmpDir()
    writeConfig(dir)
    writeScheduledImplementation(dir, "goal-scheduler")
    previousEnv.GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME
    previousEnv.GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "pull_request"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "closed",
      pull_request: {
        number: 738,
        merged: true,
        head: { ref: "dev" },
        base: { ref: "main" },
      },
    })

    await expect(runCi(["--cwd", dir, "--skip-install", "--skip-litellm"])).resolves.toBe(0)

    expect(mocks.runJob).not.toHaveBeenCalled()
  })
})
