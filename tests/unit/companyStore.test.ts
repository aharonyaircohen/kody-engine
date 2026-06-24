import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadAgentIdentity } from "../../src/agents.js"
import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import { listAgentActions, listAgentResponsibilityActions, resolveAgentAction } from "../../src/registry.js"

let tmp: string
let cwdBefore: string
let envBefore: Record<string, string | undefined>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-company-store-"))
  cwdBefore = process.cwd()
  envBefore = {
    KODY_COMPANY_STORE: process.env.KODY_COMPANY_STORE,
    KODY_COMPANY_STORE_REF: process.env.KODY_COMPANY_STORE_REF,
    KODY_COMPANY_STORE_CACHE: process.env.KODY_COMPANY_STORE_CACHE,
  }
  resetCompanyStoreCacheForTests()
})

afterEach(() => {
  process.chdir(cwdBefore)
  restoreEnv()
  resetCompanyStoreCacheForTests()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("company store resolution", () => {
  it("loads agentActions, agentResponsibility actions, and agent from a remote git ref", () => {
    const remote = createStoreRepo()
    const consumer = path.join(tmp, "consumer")
    fs.mkdirSync(consumer, { recursive: true })
    process.chdir(consumer)
    configureStore(remote)

    expect(resolveAgentAction("store-exe")).toMatch(/store-exe\/profile\.json$/)
    expect(listAgentActions().some((exe) => exe.name === "store-exe")).toBe(true)

    const action = listAgentResponsibilityActions().find((item) => item.action === "store-agent-responsibility")
    expect(action?.source).toBe("company-store")
    expect(action?.agentAction).toBe("store-exe")

    expect(loadAgentIdentity(consumer, "cto")).toBe("Store CTO agent.")
  })

  it("keeps local assets ahead of company store assets", () => {
    const remote = createStoreRepo()
    const consumer = path.join(tmp, "consumer")
    writeAgentAction(path.join(consumer, ".kody", "agent-actions"), "store-exe", { name: "local" })
    writeAgentResponsibility(path.join(consumer, ".kody", "agent-responsibilities"), "store-agent-responsibility", {
      profile: { action: "store-agent-responsibility", agentAction: "store-exe" },
      body: "# Local Store AgentResponsibility\n",
    })
    fs.mkdirSync(path.join(consumer, ".kody", "agents"), { recursive: true })
    fs.writeFileSync(path.join(consumer, ".kody", "agents", "cto.md"), "Local CTO agent.")
    process.chdir(consumer)
    configureStore(remote)

    expect(fs.realpathSync(resolveAgentAction("store-exe")!)).toBe(
      fs.realpathSync(path.join(consumer, ".kody", "agent-actions", "store-exe", "profile.json")),
    )
    expect(listAgentResponsibilityActions().find((item) => item.action === "store-agent-responsibility")?.source).toBe(
      "project-folder",
    )
    expect(loadAgentIdentity(consumer, "cto")).toBe("Local CTO agent.")
  })
})

function configureStore(remote: string): void {
  process.env.KODY_COMPANY_STORE = `file://${remote}`
  process.env.KODY_COMPANY_STORE_REF = "stable"
  process.env.KODY_COMPANY_STORE_CACHE = path.join(tmp, "cache")
  resetCompanyStoreCacheForTests()
}

function createStoreRepo(): string {
  const repo = path.join(tmp, "store")
  writeAgentAction(path.join(repo, ".kody", "agent-actions"), "store-exe", { name: "store-exe" })
  writeAgentResponsibility(path.join(repo, ".kody", "agent-responsibilities"), "store-agent-responsibility", {
    profile: { action: "store-agent-responsibility", agentAction: "store-exe", every: "manual", agent: "cto" },
    body: "# Store AgentResponsibility\nShared agentResponsibility body.\n",
  })
  fs.mkdirSync(path.join(repo, ".kody", "agents"), { recursive: true })
  fs.writeFileSync(path.join(repo, ".kody", "agents", "cto.md"), "Store CTO agent.")

  git(repo, ["init", "-b", "stable"])
  git(repo, ["add", "."])
  git(repo, ["-c", "user.name=Kody Test", "-c", "user.email=kody@example.invalid", "commit", "-m", "store"])
  return repo
}

function writeAgentAction(root: string, slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(root, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), `${JSON.stringify(profile)}\n`)
}

function writeAgentResponsibility(
  root: string,
  slug: string,
  input: { profile: Record<string, unknown>; body: string },
): void {
  const dir = path.join(root, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), `${JSON.stringify(input.profile)}\n`)
  fs.writeFileSync(path.join(dir, "agent-responsibility.md"), input.body)
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(envBefore)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
