import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import { loadProfile } from "../../src/profile.js"
import { listCapabilityActions, resolveCapabilityFolder, resolveImplementation } from "../../src/registry.js"

const STORE_ROOT = process.env.KODY_STORE_PATH ?? path.resolve(process.cwd(), "..", "kody-store")
const STORE_CAPABILITIES_ROOT = resolveStoreAssetRoot("capabilities")
const CHAT_CAPABILITY_ALIASES = new Set(["kody-analyzer", "kody-mem", "kody-operator", "kody-vibe"])
const MIGRATED_FULL_CAPABILITY_ACTIONS = ["classify", "qa-engineer", "agent-ask"]
const WORKFLOW_CAPABILITY_ACTIONS = new Map([
  ["bug", "reproduce"],
  ["feature", "research"],
  ["chore", "run"],
  ["spec", "research"],
])
const REQUIRED_INTERNAL_CAPABILITY_PROFILES = [
  "capability-scheduler",
  "capability-tick",
  "capability-tick-scripted",
  "ci-check",
  "compact-memory",
  "goal-manager",
  "goal-scheduler",
  "kody-chat",
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
    if (!fs.existsSync(STORE_CAPABILITIES_ROOT)) return

    const missingName: string[] = []
    for (const slug of fs.readdirSync(STORE_CAPABILITIES_ROOT).sort()) {
      const profilePath = path.join(STORE_CAPABILITIES_ROOT, slug, "profile.json")
      if (!fs.existsSync(profilePath)) continue
      const raw = JSON.parse(fs.readFileSync(profilePath, "utf8")) as { name?: unknown }
      if (typeof raw.name !== "string" || !raw.name.trim()) {
        missingName.push(slug)
      }
    }

    expect(missingName).toEqual([])
  })

  it("keeps full store capability action profiles loadable", () => {
    if (!fs.existsSync(STORE_CAPABILITIES_ROOT)) return

    const invalid: string[] = []
    const actionSlugs: string[] = []

    for (const slug of fs.readdirSync(STORE_CAPABILITIES_ROOT).sort()) {
      const profilePath = path.join(STORE_CAPABILITIES_ROOT, slug, "profile.json")
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

  it("resolves migrated store direct implementation actions", () => {
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
          implementation: action,
          source: "company-store",
        }),
      )
    }
  })

  it("resolves migrated store workflow actions", () => {
    if (!fs.existsSync(STORE_ROOT)) return

    process.env.KODY_COMPANY_STORE = STORE_ROOT
    process.env.KODY_COMPANY_STORE_REF = "stable"
    resetCompanyStoreCacheForTests()

    const actions = listCapabilityActions()
    for (const [action, firstStep] of WORKFLOW_CAPABILITY_ACTIONS) {
      expect(actions).toContainEqual(
        expect.objectContaining({
          action,
          capability: action,
          implementation: firstStep,
          source: "company-store",
        }),
      )
      expect(resolveCapabilityFolder(action)?.config.workflow?.steps[0]?.capability).toBe(firstStep)
    }

    expect(resolveCapabilityFolder("bug")?.config.workflow?.steps).toMatchObject([
      { capability: "reproduce", target: "issue", continueOn: ["REPRODUCE_FAILED"] },
      { capability: "plan", target: "issue" },
      { capability: "run", target: "issue" },
      { capability: "review", target: "pr", continueOn: ["REVIEW_FAIL"] },
      { capability: "fix", target: "pr", runWhen: { "lastOutcome.type": ["REVIEW_CONCERNS", "REVIEW_FAIL"] } },
    ])
  })

  it("keeps internal store capability helpers out of public capability actions", () => {
    if (!fs.existsSync(STORE_ROOT)) return
    process.env.KODY_COMPANY_STORE = STORE_ROOT
    process.env.KODY_COMPANY_STORE_REF = "stable"
    resetCompanyStoreCacheForTests()

    const actionNames = listCapabilityActions().map((action) => action.action)
    for (const capability of REQUIRED_INTERNAL_CAPABILITY_PROFILES) {
      const profilePath = resolveImplementation(capability)
      expect(profilePath).toBeTruthy()
      expect(fs.realpathSync(profilePath!)).toContain(fs.realpathSync(path.join(STORE_CAPABILITIES_ROOT, capability)))
      expect(actionNames).not.toContain(capability)
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
        (action) => action.implementation === "capability-tick" || action.implementation === "capability-tick-scripted",
      )
      .map((action) => action.action)

    expect(genericWrappers).toEqual([])
  })

  it("routes chat capability aliases through the kody-chat implementation", () => {
    if (!fs.existsSync(STORE_CAPABILITIES_ROOT)) return

    process.env.KODY_COMPANY_STORE = STORE_ROOT
    process.env.KODY_COMPANY_STORE_REF = "stable"
    resetCompanyStoreCacheForTests()

    const actions = listCapabilityActions()
    const aliasRoutes = actions
      .filter((action) => CHAT_CAPABILITY_ALIASES.has(action.action))
      .map((action) => [action.action, action.implementation])
      .sort(([a], [b]) => a.localeCompare(b))

    expect(aliasRoutes).toEqual([...CHAT_CAPABILITY_ALIASES].sort().map((alias) => [alias, "kody-chat"]))
    expect(resolveImplementation("kody-chat")).toBeTruthy()
  })
})

function resolveStoreAssetRoot(kind: "capabilities"): string {
  const manifestPath = path.join(STORE_ROOT, "kody-store.json")
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      assetRoots?: Record<string, unknown>
    }
    const configured = manifest.assetRoots?.[kind]
    if (typeof configured === "string" && configured.trim()) {
      return path.resolve(STORE_ROOT, configured)
    }
  }
  return path.join(STORE_ROOT, ".kody", kind)
}
