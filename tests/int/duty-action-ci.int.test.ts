import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { main } from "../../src/entry.js"

let prevCwd = process.cwd()
const prevEnv = { ...process.env }

afterEach(() => {
  process.chdir(prevCwd)
  process.env = { ...prevEnv }
})

function makeRepo(opts: { sameName?: boolean } = {}): { root: string; eventPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-duty-action-ci-"))
  const dutyName = opts.sameName ? "noop" : "noop-duty"
  const exeName = opts.sameName ? "noop" : "noop-impl"
  fs.mkdirSync(path.join(root, ".kody", "duties"), { recursive: true })
  fs.mkdirSync(path.join(root, ".kody", "executables", exeName), { recursive: true })
  fs.writeFileSync(
    path.join(root, "kody.config.json"),
    JSON.stringify(
      {
        quality: { typecheck: "", lint: "", format: "", testUnit: "" },
        git: { defaultBranch: "main" },
        github: { owner: "o", repo: "r" },
        agent: { model: "anthropic/test" },
      },
      null,
      2,
    ),
  )
  fs.mkdirSync(path.join(root, ".kody", "duties", dutyName), { recursive: true })
  fs.writeFileSync(
    path.join(root, ".kody", "duties", dutyName, "profile.json"),
    JSON.stringify({ name: dutyName, action: "noop", executable: exeName, staff: "kody" }),
  )
  fs.writeFileSync(path.join(root, ".kody", "duties", dutyName, "duty.md"), "# Noop\n")
  fs.writeFileSync(
    path.join(root, ".kody", "executables", exeName, "profile.json"),
    JSON.stringify(
      {
        name: exeName,
        role: "utility",
        describe: "offline duty-action integration fixture",
        kind: "oneshot",
        inputs: [{ name: "issue", flag: "--issue", type: "int", required: true, describe: "issue" }],
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
        scripts: { preflight: [{ script: "skipAgent" }], postflight: [] },
      },
      null,
      2,
    ),
  )
  const eventPath = path.join(root, "event.json")
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      comment: { body: "@kody noop", user: { login: "alice", type: "User" } },
      issue: { number: 123 },
    }),
  )
  return { root, eventPath }
}

describe("ci duty action route", () => {
  it("runs a public duty action and lowers it to its implementation executable", async () => {
    prevCwd = process.cwd()
    const { root, eventPath } = makeRepo()
    process.chdir(root)
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = eventPath
    delete process.env.GITHUB_REPOSITORY

    const code = await main(["noop", "--cwd", root, "--issue", "123", "--quiet"])

    expect(code).toBe(0)
  })

  it("supports a duty and implementation executable with the same slug", async () => {
    prevCwd = process.cwd()
    const { root, eventPath } = makeRepo({ sameName: true })
    process.chdir(root)
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = eventPath
    delete process.env.GITHUB_REPOSITORY

    const code = await main(["noop", "--cwd", root, "--issue", "123", "--quiet"])

    expect(code).toBe(0)
  })
})
