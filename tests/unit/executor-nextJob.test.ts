import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const stateApi = vi.hoisted(() => {
  const files = new Map<string, { content: string; sha: string }>()
  let seq = 1
  const gh = vi.fn((args: string[], options?: { input?: string }) => {
    const apiPath = args.find((arg) => arg.startsWith("/repos/") && arg.includes("/contents/"))
    if (!apiPath) return ""

    if (args.includes("--method") && args.includes("PUT")) {
      const payload = JSON.parse(options?.input ?? "{}") as { content?: string }
      const sha = `sha-${seq++}`
      files.set(apiPath, { content: payload.content ?? "", sha })
      return JSON.stringify({ content: { sha } })
    }

    const file = files.get(apiPath)
    if (!file) throw new Error("gh: Not Found (HTTP 404)")
    return JSON.stringify({
      type: "file",
      encoding: "base64",
      content: file.content,
      sha: file.sha,
      path: apiPath.split("/contents/")[1],
    })
  })

  return {
    gh,
    reset() {
      gh.mockClear()
      files.clear()
      seq = 1
    },
  }
})

vi.mock("../../src/issue.js", async (orig) => {
  const actual = await orig<typeof import("../../src/issue.js")>()
  return { ...actual, gh: stateApi.gh }
})
vi.mock("../../src/state-backend.js", () => ({
  createStateBackendFromEnv: () => ({ save: vi.fn(async () => undefined) }),
  hasStateBackendConfig: () => false,
}))

import type { KodyConfig } from "../../src/config.js"
import { runImplementationChain } from "../../src/executor.js"
import { emptyState, upsertTaskJobs } from "../../src/state.js"

const config: KodyConfig = {
  quality: { typecheck: "", lint: "", testUnit: "", format: "" },
  git: { defaultBranch: "main" },
  github: { owner: "o", repo: "r" },
  agent: { model: "claude/claude-haiku-4-5-20251001" },
}

function writeProfile(root: string, name: string, preflight: unknown[], postflight: unknown[] = []): void {
  const dir = path.join(root, ".kody-engine", "definitions", "capabilities", name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "profile.json"),
    JSON.stringify(
      {
        name,
        action: name,
        role: "utility",
        describe: "",
        inputs: [{ name: "issue", flag: "--issue", type: "int", required: true, describe: "" }],
        claudeCode: {
          model: "inherit",
          permissionMode: "default",
          maxTurns: 0,
          maxThinkingTokens: null,
          systemPromptAppend: null,
          tools: [],
          hooks: [],
          skills: [],
          commands: [],
          subagents: [],
          plugins: [],
          mcpServers: [],
        },
        cliTools: [],
        scripts: { preflight, postflight },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(dir, "capability.md"), `# ${name}\n\nRun ${name}.\n`)
  fs.writeFileSync(path.join(dir, "prompt.md"), "")
}

describe("executor: nextJob chain", () => {
  let tmp = ""
  const originalCwd = process.cwd()

  afterEach(() => {
    stateApi.reset()
    process.chdir(originalCwd)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    tmp = ""
  })

  it("returns to the parent after a planned child succeeds", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-next-job-"))
    process.chdir(tmp)
    writeProfile(tmp, "parent", [{ script: "dispatchNextTaskJob" }, { script: "skipAgent" }])
    writeProfile(tmp, "child", [{ script: "skipAgent" }], [{ script: "saveTaskState" }])

    const plannedJob = {
      capability: "child",
      implementation: "child",
      cliArgs: { issue: 42 },
      target: 42,
      flavor: "instant" as const,
      why: "child slice",
    }
    const taskState = upsertTaskJobs(
      emptyState(),
      [
        {
          id: "instant:child:42",
          capability: "child",
          implementation: "child",
          flavor: "instant",
          target: 42,
          reason: "child slice",
        },
      ],
      "2026-06-08T08:00:00Z",
    )

    const result = await runImplementationChain("parent", {
      cliArgs: { issue: 42 },
      cwd: tmp,
      config,
      preloadedData: {
        taskState,
        plannedTaskJobs: [plannedJob],
        plannedTaskJobIds: ["instant:child:42"],
        commentTargetType: "issue",
        commentTargetNumber: 42,
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.reason).toBe("all planned task jobs are complete")
    expect(result.nextJob).toBeUndefined()
    expect(result.taskState?.jobs["instant:child:42"]?.status).toBe("succeeded")
  })

  it("retries a failed planned child on rerun before moving to later children", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-next-job-rerun-"))
    process.chdir(tmp)
    writeProfile(tmp, "parent", [{ script: "dispatchNextTaskJob" }, { script: "skipAgent" }])
    writeProfile(
      tmp,
      "failer",
      [{ script: "skipAgent" }],
      [{ script: "failOnceTaskJob" }, { script: "recordOutcome" }, { script: "saveTaskState" }],
    )
    writeProfile(tmp, "child", [{ script: "skipAgent" }], [{ script: "recordOutcome" }, { script: "saveTaskState" }])

    const failerJob = {
      capability: "failer",
      implementation: "failer",
      cliArgs: { issue: 42 },
      target: 42,
      flavor: "instant" as const,
      why: "first slice",
    }
    const childJob = {
      capability: "child",
      implementation: "child",
      cliArgs: { issue: 42 },
      target: 42,
      flavor: "instant" as const,
      why: "second slice",
    }
    const ids = ["instant:failer:42", "instant:child:42"]
    const taskState = upsertTaskJobs(
      emptyState(),
      [
        {
          id: "instant:failer:42",
          capability: "failer",
          implementation: "failer",
          flavor: "instant",
          target: 42,
          reason: "first slice",
        },
        {
          id: "instant:child:42",
          capability: "child",
          implementation: "child",
          flavor: "instant",
          target: 42,
          reason: "second slice",
        },
      ],
      "2026-06-08T08:00:00Z",
    )
    const baseData = {
      plannedTaskJobs: [failerJob, childJob],
      plannedTaskJobIds: ids,
      commentTargetType: "issue",
      commentTargetNumber: 42,
    }

    const first = await runImplementationChain("parent", {
      cliArgs: { issue: 42 },
      cwd: tmp,
      config,
      preloadedData: { ...baseData, taskState },
    })

    expect(first.exitCode).toBe(1)
    expect(first.taskState?.jobs["instant:failer:42"]?.status).toBe("failed")
    expect(first.taskState?.jobs["instant:child:42"]?.status).toBe("pending")

    const second = await runImplementationChain("parent", {
      cliArgs: { issue: 42 },
      cwd: tmp,
      config,
      preloadedData: { ...baseData, taskState: first.taskState },
    })

    expect(second.exitCode).toBe(0)
    expect(second.reason).toBe("all planned task jobs are complete")
    expect(second.taskState?.jobs["instant:failer:42"]?.status).toBe("succeeded")
    expect(second.taskState?.jobs["instant:failer:42"]?.agentRuns.map((run) => run.status)).toEqual([
      "failed",
      "succeeded",
    ])
    expect(second.taskState?.jobs["instant:child:42"]?.status).toBe("succeeded")
  })
})
