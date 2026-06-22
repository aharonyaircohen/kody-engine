import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import { loadProfile } from "../../src/profile.js"
import { listAgentResponsibilityActions, resolveAgentAction } from "../../src/registry.js"

const STORE_ROOT = process.env.KODY_STORE_PATH ?? path.resolve(process.cwd(), "..", "kody-store")
const STORE_DUTIES_ROOT = path.join(STORE_ROOT, ".kody", "agent-responsibilities")
const STORE_EXECUTABLES_ROOT = path.join(STORE_ROOT, ".kody", "agent-actions")
const CAPABILITY_KINDS = new Set(["observe", "act", "verify"])
const CHAT_AGENT_RESPONSIBILITY_ALIASES = new Set(["kody-analyzer", "kody-mem", "kody-operator", "kody-vibe"])
const MIGRATED_EXECUTABLE_ACTIONS = ["classify", "qa-engineer", "spec", "agent-ask"]
const INTERNAL_EXECUTABLE_ONLY_PROFILES = [
  "agent-responsibility-scheduler",
  "agent-responsibility-tick",
  "agent-responsibility-tick-scripted",
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

describe("kody-store capabilityKind profiles", () => {
  it("keeps every remaining store agentResponsibility profile typed", () => {
    if (!fs.existsSync(STORE_DUTIES_ROOT)) return

    const missingOrInvalid: string[] = []
    for (const slug of fs.readdirSync(STORE_DUTIES_ROOT).sort()) {
      const profilePath = path.join(STORE_DUTIES_ROOT, slug, "profile.json")
      if (!fs.existsSync(profilePath)) continue
      const raw = JSON.parse(fs.readFileSync(profilePath, "utf8")) as { capabilityKind?: unknown }
      if (typeof raw.capabilityKind !== "string" || !CAPABILITY_KINDS.has(raw.capabilityKind)) {
        missingOrInvalid.push(slug)
      }
    }

    expect(missingOrInvalid).toEqual([])
  })

  it("keeps direct store agentAction actions typed and loadable", () => {
    if (!fs.existsSync(STORE_EXECUTABLES_ROOT)) return

    const invalid: string[] = []
    const actionSlugs: string[] = []

    for (const slug of fs.readdirSync(STORE_EXECUTABLES_ROOT).sort()) {
      const profilePath = path.join(STORE_EXECUTABLES_ROOT, slug, "profile.json")
      if (!fs.existsSync(profilePath)) continue
      const raw = JSON.parse(fs.readFileSync(profilePath, "utf8")) as {
        action?: unknown
        capabilityKind?: unknown
      }
      if (typeof raw.action !== "string" || !raw.action.trim()) continue

      actionSlugs.push(slug)
      if (typeof raw.capabilityKind !== "string" || !CAPABILITY_KINDS.has(raw.capabilityKind)) {
        invalid.push(`${slug}: capabilityKind`)
        continue
      }

      try {
        loadProfile(profilePath)
      } catch (error) {
        invalid.push(`${slug}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    expect(invalid).toEqual([])
    expect(actionSlugs).toEqual(expect.arrayContaining(MIGRATED_EXECUTABLE_ACTIONS))
  })

  it("resolves migrated store direct agentAction actions", () => {
    if (!fs.existsSync(STORE_ROOT)) return

    process.env.KODY_COMPANY_STORE = STORE_ROOT
    process.env.KODY_COMPANY_STORE_REF = "stable"
    resetCompanyStoreCacheForTests()

    const actions = listAgentResponsibilityActions()
    for (const action of MIGRATED_EXECUTABLE_ACTIONS) {
      expect(actions).toContainEqual(
        expect.objectContaining({
          action,
          agentResponsibility: action,
          agentAction: action,
          source: "company-store-agentAction",
        }),
      )
    }
  })

  it("keeps internal store agentAction helpers out of public agentResponsibility actions", () => {
    if (!fs.existsSync(STORE_ROOT)) return
    process.env.KODY_COMPANY_STORE = STORE_ROOT
    process.env.KODY_COMPANY_STORE_REF = "stable"
    resetCompanyStoreCacheForTests()

    const actionNames = listAgentResponsibilityActions().map((action) => action.action)
    for (const agentAction of INTERNAL_EXECUTABLE_ONLY_PROFILES) {
      expect(resolveAgentAction(agentAction)).toBeTruthy()
      expect(actionNames).not.toContain(agentAction)
    }
  })

  it("does not route explicit store actions through generic agentResponsibility tick wrappers", () => {
    if (!fs.existsSync(STORE_ROOT)) return

    process.env.KODY_COMPANY_STORE = STORE_ROOT
    process.env.KODY_COMPANY_STORE_REF = "stable"
    resetCompanyStoreCacheForTests()

    const genericWrappers = listAgentResponsibilityActions()
      .filter((action) => action.source === "company-store")
      .filter(
        (action) =>
          action.agentAction === "agent-responsibility-tick" ||
          action.agentAction === "agent-responsibility-tick-scripted",
      )
      .map((action) => action.action)

    expect(genericWrappers).toEqual([])
  })

  it("names the remaining non-engine chat agentResponsibility aliases explicitly", () => {
    if (!fs.existsSync(STORE_DUTIES_ROOT)) return

    process.env.KODY_COMPANY_STORE = STORE_ROOT
    process.env.KODY_COMPANY_STORE_REF = "stable"
    resetCompanyStoreCacheForTests()

    const nonEngineAliases: string[] = []
    for (const slug of fs.readdirSync(STORE_DUTIES_ROOT).sort()) {
      const profilePath = path.join(STORE_DUTIES_ROOT, slug, "profile.json")
      if (!fs.existsSync(profilePath)) continue
      const raw = JSON.parse(fs.readFileSync(profilePath, "utf8")) as { action?: unknown; agentAction?: unknown }
      if (typeof raw.action !== "string" || typeof raw.agentAction !== "string") continue

      const executablePath = resolveAgentAction(raw.agentAction)
      if (!executablePath) continue

      try {
        loadProfile(executablePath)
      } catch {
        nonEngineAliases.push(slug)
      }
    }

    expect(nonEngineAliases).toEqual([...CHAT_AGENT_RESPONSIBILITY_ALIASES].sort())
  })
})
