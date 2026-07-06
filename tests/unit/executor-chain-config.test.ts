import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runJob: vi.fn(async (_job: unknown, _base: unknown) => ({ exitCode: 0 })),
}))

vi.mock("../../src/job.js", () => ({
  runJob: mocks.runJob,
}))

import { runImplementationChain } from "../../src/executor.js"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-chain-config-"))
}

function writeConfig(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "kody.config.json"),
    JSON.stringify({
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "owner", repo: "repo" },
      state: { repo: "owner/kody-state", path: "repo" },
      agent: { model: "claude/claude-haiku-4-5-20251001" },
    }),
  )
}

function writeDispatchingProfile(dir: string): void {
  const profileDir = path.join(dir, ".kody", "capabilities", "parent")
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, "capability.md"), "# Parent\n")
  fs.writeFileSync(
    path.join(profileDir, "profile.json"),
    JSON.stringify({
      name: "parent",
      action: "parent",
      role: "utility",
      describe: "Parent dispatch test profile.",
      inputs: [{ name: "issue", flag: "--issue", type: "int", required: true, describe: "Issue number." }],
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
      scripts: {
        preflight: [{ script: "skipAgent" }],
        postflight: [{ script: "dispatch", with: { next: "web-release", target: "issue" } }],
      },
    }),
  )
}

describe("executor: chain config propagation", () => {
  let tmp = ""
  const originalCwd = process.cwd()

  afterEach(() => {
    process.chdir(originalCwd)
    mocks.runJob.mockClear()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    tmp = ""
  })

  it("loads repo config for child handoffs when the chain caller did not preload it", async () => {
    tmp = tmpDir()
    writeConfig(tmp)
    writeDispatchingProfile(tmp)
    process.chdir(tmp)

    const result = await runImplementationChain("parent", {
      cwd: tmp,
      cliArgs: { issue: 42 },
    })

    expect(result.exitCode).toBe(0)
    expect(mocks.runJob).toHaveBeenCalledTimes(1)
    const [job, base] = mocks.runJob.mock.calls[0]!
    expect(job).toMatchObject({
      action: "web-release",
      cliArgs: { issue: 42 },
    })
    expect(base).toMatchObject({
      cwd: tmp,
      config: {
        github: { owner: "owner", repo: "repo" },
        state: { repo: "owner/kody-state", path: "repo" },
      },
    })
  })
})
