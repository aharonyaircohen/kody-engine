import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import { loadProfile } from "../../src/profile.js"
import { listCapabilityActions, resolveExecutable } from "../../src/registry.js"

const STORE_ROOT = process.env.KODY_STORE_PATH ?? path.resolve(process.cwd(), "..", "kody-store")
const STORE_DUTIES_ROOT = path.join(STORE_ROOT, ".kody", "capabilities")
const STORE_EXECUTABLES_ROOT = path.join(STORE_ROOT, ".kody", "executables")
const CHAT_CAPABILITY_ALIASES = new Set(["kody-analyzer", "kody-mem", "kody-operator", "kody-vibe"])
const MIGRATED_FULL_CAPABILITY_ACTIONS = ["classify", "qa-engineer", "spec", "agent-ask"]
const INTERNAL_EXECUTABLE_ONLY_PROFILES = [
  "capability-scheduler",
  "capability-tick",
  "capability-tick-scripted",
  "goal-manager",
  "goal-scheduler",
  "release",
  "task-job-fail-once",
  "task-jobs",
]

let envBefore: Record<string, string | undefined>

beforeEach(() => {
  envBefore = {
    KODY_COMPANY_STORE: process.env.KODY_COMPANY_STORE,
    KODY_COMPANY_STORE_REF: process.env.KODY_COMPANY_STORE_REF,
  }
  resetCompanyStoreCacheForTests()
})

afterEach(() => {
  for (const [key, value] of Object.entries(envBefore)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetCompanyStoreCacheForTests()
})

describe("kody-store capability profiles", () => {
  it("keeps every remaining store capability profile named", () => {
    if (!fs.existsSync(STORE_DUTIES_ROOT)) return

    const missingName: string[] = []
    for (const slug of fs.readdirSync(STORE_DUTIES_ROOT).sort()) {
      const profilePath = path.join(STORE_DUTIES_ROOT, slug, "profile.json")
      if (!fs.existsSync(profilePath)) continue
      const raw = JSON.parse(fs.readFileSync(profilePath, "utf8")) as { name?: unknown }
      if (typeof raw.name !== "string" || !raw.name.trim()) {
        missingName.push(slug)
      }
    }

    expect(missingName).toEqual([])
  })

  it("keeps full store capability action profiles loadable", () => {
    if (!fs.existsSync(STORE_DUTIES_ROOT)) return

    const invalid: string[] = []
    const actionSlugs: string[] = []

    for (const slug of fs.readdirSync(STORE_DUTIES_ROOT).sort()) {
      const profilePath = path.join(STORE_DUTIES_ROOT, slug, "profile.json")
      if (!fs.existsSync(profilePath)) continue
      const raw = JSON.parse(fs.readFileSync(profilePath, "utf8")) as {
        action?: unknown
        role?: unknown
      }
      if (typeof raw.action !== "string" || !raw.action.trim() || typeof raw.role !== "string") continue

      actionSlugs.push(slug)
      try {
        loadProfile(profilePath)
      } catch (error) {
        invalid.push(`${slug}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    expect(invalid).toEqual([])
    expect(actionSlugs).toEqual(expect.arrayContaining(MIGRATED_FULL_CAPABILITY_ACTIONS))
  })

  it("resolves migrated store direct executable actions", () => {
    if (!fs.existsSync(STORE_ROOT)) return

    process.env.KODY_COMPANY_STORE = STORE_ROOT
    process.env.KODY_COMPANY_STORE_REF = "stable"
    resetCompanyStoreCacheForTests()

    const actions = listCapabilityActions()
    for (const action of MIGRATED_FULL_CAPABILITY_ACTIONS) {
      expect(actions).toContainEqual(
        expect.objectContaining({
          action,
          capability: action,
          executable: action,
          source: "company-store",
        }),
      )
    }
  })

  it("keeps internal store executable helpers out of public capability actions", () => {
    if (!fs.existsSync(STORE_ROOT)) return
    process.env.KODY_COMPANY_STORE = STORE_ROOT
    process.env.KODY_COMPANY_STORE_REF = "stable"
    resetCompanyStoreCacheForTests()

    const actionNames = listCapabilityActions().map((action) => action.action)
    for (const executable of INTERNAL_EXECUTABLE_ONLY_PROFILES) {
      expect(resolveExecutable(executable)).toBeTruthy()
      expect(actionNames).not.toContain(executable)
    }
  })

  it("does not route explicit store actions through generic capability tick wrappers", () => {
    if (!fs.existsSync(STORE_ROOT)) return

    process.env.KODY_COMPANY_STORE = STORE_ROOT
    process.env.KODY_COMPANY_STORE_REF = "stable"
    resetCompanyStoreCacheForTests()

    const genericWrappers = listCapabilityActions()
      .filter((action) => action.source === "company-store")
      .filter(
        (action) =>
          action.executable === "capability-tick" ||
          action.executable === "capability-tick-scripted",
      )
      .map((action) => action.action)

    expect(genericWrappers).toEqual([])
  })

  it("routes chat capability aliases through the kody-chat executable", () => {
    if (!fs.existsSync(STORE_DUTIES_ROOT)) return

    process.env.KODY_COMPANY_STORE = STORE_ROOT
    process.env.KODY_COMPANY_STORE_REF = "stable"
    resetCompanyStoreCacheForTests()

    const actions = listCapabilityActions()
    const aliasRoutes = actions
      .filter((action) => CHAT_CAPABILITY_ALIASES.has(action.action))
      .map((action) => [action.action, action.executable])
      .sort(([a], [b]) => a.localeCompare(b))

    expect(aliasRoutes).toEqual([...CHAT_CAPABILITY_ALIASES].sort().map((alias) => [alias, "kody-chat"]))
    expect(resolveExecutable("kody-chat")).toBeTruthy()
  })
})
