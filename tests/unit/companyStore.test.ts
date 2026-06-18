import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import { listDutyActions, listExecutables, resolveExecutable } from "../../src/registry.js"
import { loadStaffPersona } from "../../src/staff.js"

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
  it("loads executables, duty actions, and staff from a remote git ref", () => {
    const remote = createStoreRepo()
    const consumer = path.join(tmp, "consumer")
    fs.mkdirSync(consumer, { recursive: true })
    process.chdir(consumer)
    configureStore(remote)

    expect(resolveExecutable("store-exe")).toMatch(/store-exe\/profile\.json$/)
    expect(listExecutables().some((exe) => exe.name === "store-exe")).toBe(true)

    const action = listDutyActions().find((item) => item.action === "store-duty")
    expect(action?.source).toBe("company-store")
    expect(action?.executable).toBe("store-exe")

    expect(loadStaffPersona(consumer, "cto")).toBe("Store CTO persona.")
  })

  it("keeps local assets ahead of company store assets", () => {
    const remote = createStoreRepo()
    const consumer = path.join(tmp, "consumer")
    writeExecutable(path.join(consumer, ".kody", "executables"), "store-exe", { name: "local" })
    writeDuty(path.join(consumer, ".kody", "duties"), "store-duty", {
      profile: { action: "store-duty", executable: "local-exe" },
      body: "# Local Store Duty\n",
    })
    fs.mkdirSync(path.join(consumer, ".kody", "staff"), { recursive: true })
    fs.writeFileSync(path.join(consumer, ".kody", "staff", "cto.md"), "Local CTO persona.")
    process.chdir(consumer)
    configureStore(remote)

    expect(fs.realpathSync(resolveExecutable("store-exe")!)).toBe(
      fs.realpathSync(path.join(consumer, ".kody", "executables", "store-exe", "profile.json")),
    )
    expect(listDutyActions().find((item) => item.action === "store-duty")?.source).toBe("project-folder")
    expect(loadStaffPersona(consumer, "cto")).toBe("Local CTO persona.")
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
  writeExecutable(path.join(repo, ".kody", "executables"), "store-exe", { name: "store-exe" })
  writeDuty(path.join(repo, ".kody", "duties"), "store-duty", {
    profile: { action: "store-duty", executable: "store-exe", every: "manual", staff: "cto" },
    body: "# Store Duty\nShared duty body.\n",
  })
  fs.mkdirSync(path.join(repo, ".kody", "staff"), { recursive: true })
  fs.writeFileSync(path.join(repo, ".kody", "staff", "cto.md"), "Store CTO persona.")

  git(repo, ["init", "-b", "stable"])
  git(repo, ["add", "."])
  git(repo, ["-c", "user.name=Kody Test", "-c", "user.email=kody@example.invalid", "commit", "-m", "store"])
  return repo
}

function writeExecutable(root: string, slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(root, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), `${JSON.stringify(profile)}\n`)
}

function writeDuty(
  root: string,
  slug: string,
  input: { profile: Record<string, unknown>; body: string },
): void {
  const dir = path.join(root, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), `${JSON.stringify(input.profile)}\n`)
  fs.writeFileSync(path.join(dir, "duty.md"), input.body)
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
