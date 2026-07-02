import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadAgentIdentity } from "../../src/agents.js"
import { applyCompanyStoreRuntimeConfig, resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import { listCapabilityActions, listExecutables, resolveExecutable } from "../../src/registry.js"

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
  it("applies Dashboard-provided store target as runtime env", () => {
    applyCompanyStoreRuntimeConfig({
      storeRepoUrl: "https://github.com/acme/kody-store",
      storeRef: "main",
    })

    expect(process.env.KODY_COMPANY_STORE).toBe("https://github.com/acme/kody-store")
    expect(process.env.KODY_COMPANY_STORE_REF).toBe("main")
  })

  it("loads capabilities and agents from a remote git ref", () => {
    const remote = createStoreRepo()
    const consumer = path.join(tmp, "consumer")
    fs.mkdirSync(consumer, { recursive: true })
    process.chdir(consumer)
    configureStore(remote)

    expect(resolveExecutable("store-exe")).toMatch(/store-exe\/profile\.json$/)
    expect(listExecutables().some((exe) => exe.name === "store-exe")).toBe(true)
    expect(resolveExecutable("legacy-store-exe")).toBeNull()
    expect(listExecutables().some((exe) => exe.name === "legacy-store-exe")).toBe(false)

    const action = listCapabilityActions().find((item) => item.action === "store-capability")
    expect(action?.source).toBe("company-store")
    expect(action?.executable).toBe("store-exe")

    expect(loadAgentIdentity(consumer, "cto")).toBe("Store CTO agent.")
  })

  it("loads root-layout stores declared by kody-store.json", () => {
    const remote = createRootLayoutStoreRepo()
    const consumer = path.join(tmp, "consumer")
    fs.mkdirSync(consumer, { recursive: true })
    process.chdir(consumer)
    configureStore(remote)

    expect(resolveExecutable("store-exe")).toMatch(/store-exe\/profile\.json$/)
    expect(listExecutables().some((exe) => exe.name === "store-exe")).toBe(true)
    expect(resolveExecutable("store-capability")).toBeNull()
    expect(listExecutables().some((exe) => exe.name === "store-capability")).toBe(false)

    const action = listCapabilityActions().find((item) => item.action === "store-capability")
    expect(action).toMatchObject({
      action: "store-capability",
      capability: "store-capability",
      executable: "store-exe",
      source: "company-store",
    })

    expect(loadAgentIdentity(consumer, "cto")).toBe("Root-layout Store CTO agent.")
  })

  it("keeps local assets ahead of company store assets", () => {
    const remote = createStoreRepo()
    const consumer = path.join(tmp, "consumer")
    writeCapability(path.join(consumer, ".kody", "capabilities"), "store-exe", {
      name: "store-exe",
      role: "utility",
      inputs: [],
    })
    writeCapability(path.join(consumer, ".kody", "capabilities"), "store-capability", {
      name: "store-capability",
      action: "store-capability",
      implementation: "store-exe",
      body: "# Local Store Capability\n",
    })
    fs.mkdirSync(path.join(consumer, ".kody", "agents"), { recursive: true })
    fs.writeFileSync(path.join(consumer, ".kody", "agents", "cto.md"), "Local CTO agent.")
    process.chdir(consumer)
    configureStore(remote)

    expect(fs.realpathSync(resolveExecutable("store-exe")!)).toBe(
      fs.realpathSync(path.join(consumer, ".kody", "capabilities", "store-exe", "profile.json")),
    )
    expect(listCapabilityActions().find((item) => item.action === "store-capability")?.source).toBe("project-folder")
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
  writeCapability(path.join(repo, ".kody", "capabilities"), "store-exe", {
    name: "store-exe",
    role: "utility",
    inputs: [],
  })
  writeCapability(path.join(repo, ".kody", "capabilities"), "store-capability", {
    name: "store-capability",
    action: "store-capability",
    implementation: "store-exe",
    every: "manual",
    agent: "cto",
    body: "# Store Capability\nShared capability body.\n",
  })
  fs.mkdirSync(path.join(repo, ".kody", "agents"), { recursive: true })
  fs.writeFileSync(path.join(repo, ".kody", "agents", "cto.md"), "Store CTO agent.")
  fs.mkdirSync(path.join(repo, ".kody", "executables", "legacy-store-exe"), { recursive: true })
  fs.writeFileSync(
    path.join(repo, ".kody", "executables", "legacy-store-exe", "profile.json"),
    '{"name":"legacy-store-exe","role":"utility","inputs":[]}\n',
  )

  git(repo, ["init", "-b", "stable"])
  git(repo, ["add", "."])
  git(repo, ["-c", "user.name=Kody Test", "-c", "user.email=kody@example.invalid", "commit", "-m", "store"])
  return repo
}

function createRootLayoutStoreRepo(): string {
  const repo = path.join(tmp, "root-layout-store")
  fs.mkdirSync(repo, { recursive: true })
  fs.writeFileSync(
    path.join(repo, "kody-store.json"),
    `${JSON.stringify(
      {
        name: "test-store",
        layoutVersion: 1,
        assetRoots: {
          capabilities: "capabilities",
          agent: "agents",
        },
      },
      null,
      2,
    )}\n`,
  )
  writeCapability(path.join(repo, "capabilities"), "store-exe", {
    name: "store-exe",
    role: "utility",
    inputs: [],
  })
  writeCapability(path.join(repo, "capabilities"), "store-capability", {
    name: "store-capability",
    action: "store-capability",
    implementation: "store-exe",
    every: "manual",
    agent: "cto",
    body: "# Store Capability\nShared root-layout capability body.\n",
  })
  fs.mkdirSync(path.join(repo, "agents"), { recursive: true })
  fs.writeFileSync(path.join(repo, "agents", "cto.md"), "Root-layout Store CTO agent.")

  git(repo, ["init", "-b", "stable"])
  git(repo, ["add", "."])
  git(repo, ["-c", "user.name=Kody Test", "-c", "user.email=kody@example.invalid", "commit", "-m", "store"])
  return repo
}

function writeCapability(root: string, slug: string, input: Record<string, unknown> & { body?: string }): void {
  const dir = path.join(root, slug)
  fs.mkdirSync(dir, { recursive: true })
  const { body, ...profile } = input
  fs.writeFileSync(path.join(dir, "profile.json"), `${JSON.stringify(profile)}\n`)
  fs.writeFileSync(path.join(dir, "capability.md"), body ?? `# ${slug}\n`)
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
