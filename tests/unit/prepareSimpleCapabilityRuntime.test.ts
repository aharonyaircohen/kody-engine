import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/implementations/types.js"
import { prepareSimpleCapabilityRuntime } from "../../src/scripts/prepareSimpleCapabilityRuntime.js"

const roots: string[] = []

afterEach(() => {
  delete process.env.LOGIN_PASSWORD
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(): { ctx: Context; profile: Profile } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-capability-runtime-"))
  roots.push(cwd)
  const ctx = {
    cwd,
    args: {},
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "acme", repo: "shop" },
      agent: { model: "claude/haiku" },
    },
    data: {
      capabilityRequirements: { browser: true, qaCredentials: true },
      prompt: "Review the UI.",
    },
    output: { exitCode: 0 },
  } as Context
  const profile = {
    claudeCode: {
      tools: ["Read", "Bash"],
      mcpServers: [],
    },
  } as unknown as Profile
  return { ctx, profile }
}

function writeLogin(cwd: string, login: string): void {
  const dir = path.join(cwd, ".kody-engine", "runtime")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "variables.json"),
    JSON.stringify({ version: 1, variables: { LOGIN_USER: { value: login } } }),
  )
}

describe("prepareSimpleCapabilityRuntime", () => {
  it("adds the browser runtime and explains missing QA credentials", async () => {
    const { ctx, profile } = fixture()

    await prepareSimpleCapabilityRuntime(ctx, profile)

    expect(profile.claudeCode.tools).toContain("mcp__playwright")
    expect(profile.claudeCode.mcpServers).toContainEqual({
      name: "playwright",
      command: "npx",
      args: ["-y", "--package=@playwright/mcp@latest", "--", "playwright-mcp", "--headless"],
    })
    expect(ctx.data.prompt).toContain("no QA credentials configured")
    expect(ctx.data.prompt).toContain("return a blocked result")
  })

  it("provides configured credentials only inside the private agent prompt", async () => {
    const { ctx, profile } = fixture()
    writeLogin(ctx.cwd, "qa@example.com")
    process.env.LOGIN_PASSWORD = "private-password"

    await prepareSimpleCapabilityRuntime(ctx, profile)

    expect(ctx.data.prompt).toContain("qa@example.com")
    expect(ctx.data.prompt).toContain("private-password")
    expect(ctx.data.capabilityEnvironment).toBeUndefined()
  })
})
