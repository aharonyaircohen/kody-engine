import { createHash } from "node:crypto"
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-capability-action-ci-"))
  const capabilityName = opts.sameName ? "noop" : "noop-capability"
  const exeName = opts.sameName ? "noop" : "noop-impl"
  fs.mkdirSync(path.join(root, ".kody-engine", "definitions", "capabilities"), { recursive: true })
  fs.mkdirSync(path.join(root, ".kody-engine", "definitions", "implementations"), { recursive: true })
  fs.mkdirSync(path.join(root, ".kody-engine", "definitions", "agents"), { recursive: true })
  fs.copyFileSync(
    path.join(process.env.KODY_DEFINITIONS_ROOT!, "agents", "kody.md"),
    path.join(root, ".kody-engine", "definitions", "agents", "kody.md"),
  )
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
  const implementationProfile = {
    role: "utility",
    describe: "offline capability-action integration fixture",
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
  }

  const capabilityDir = path.join(root, ".kody-engine", "definitions", "capabilities", capabilityName)
  fs.mkdirSync(capabilityDir, { recursive: true })
  const capability = {
    id: capabilityName,
    action: "noop",
    purpose: "Offline capability-action integration fixture",
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", additionalProperties: true },
    effects: [],
    permissions: [],
    success: "success",
    failure: "failure",
  }
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`
    }
    return JSON.stringify(value)
  }
  fs.writeFileSync(path.join(capabilityDir, "definition.json"), JSON.stringify(capability, null, 2))
  fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Noop\n")

  const implementationDir = path.join(root, ".kody-engine", "definitions", "implementations", exeName)
  fs.mkdirSync(implementationDir, { recursive: true })
  fs.writeFileSync(
    path.join(implementationDir, "definition.json"),
    JSON.stringify(
      {
        id: exeName,
        capabilityRef: { kind: "capability", id: capabilityName },
        compatibleCapabilityRevision: createHash("sha256").update(canonical(capability)).digest("hex"),
        type: "script",
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(implementationDir, "runtime.json"),
    JSON.stringify(
      {
        adapter: "kody-engine-profile",
        inputBindings: {},
        outputBindings: {},
        requirements: {},
        name: exeName,
        internal: true,
        ...implementationProfile,
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

describe("ci capability action route", () => {
  it.skip("runs a public capability action and lowers it to its implementation", async () => {
    prevCwd = process.cwd()
    const { root, eventPath } = makeRepo()
    process.chdir(root)
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = eventPath
    delete process.env.GITHUB_REPOSITORY

    const code = await main(["noop", "--cwd", root, "--issue", "123", "--quiet"])

    expect(code).toBe(0)
  })

  it.skip("supports a capability and implementation with the same slug", async () => {
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
