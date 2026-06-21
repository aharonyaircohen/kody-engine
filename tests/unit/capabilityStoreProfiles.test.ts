import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import { loadProfile } from "../../src/profile.js"
import { resolveExecutable } from "../../src/registry.js"

const STORE_ROOT = process.env.KODY_STORE_PATH ?? path.resolve(process.cwd(), "..", "kody-store")
const STORE_DUTIES_ROOT = path.join(STORE_ROOT, ".kody", "duties")
const CLEAN_CAPABILITY_DUTY_COUNT = 56

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
  it("loads every marked store duty profile with a valid capability kind", () => {
    if (!fs.existsSync(STORE_DUTIES_ROOT)) return

    process.env.KODY_COMPANY_STORE = STORE_ROOT
    process.env.KODY_COMPANY_STORE_REF = "stable"
    resetCompanyStoreCacheForTests()

    const marked: Array<{ slug: string; kind: string }> = []
    for (const slug of fs.readdirSync(STORE_DUTIES_ROOT).sort()) {
      const profilePath = path.join(STORE_DUTIES_ROOT, slug, "profile.json")
      if (!fs.existsSync(profilePath)) continue
      const raw = JSON.parse(fs.readFileSync(profilePath, "utf8")) as {
        capabilityKind?: string
        executable?: string
        executables?: string[]
      }
      if (!raw.capabilityKind) continue
      expect(["observe", "act", "verify"]).toContain(raw.capabilityKind)
      for (const executable of referencedExecutables(raw)) {
        const executablePath = resolveExecutable(executable)
        expect(executablePath, `${slug} references ${executable}`).toBeTruthy()
        loadProfile(executablePath!)
      }
      marked.push({ slug, kind: raw.capabilityKind })
    }

    expect(marked).toHaveLength(CLEAN_CAPABILITY_DUTY_COUNT)
    expect(marked.filter((entry) => entry.kind === "observe").map((entry) => entry.slug)).toEqual([
      "cleanup",
      "code-health",
      "company-graph",
      "delivery-graph",
      "docs-health",
      "documentation-maintenance",
      "duty-call",
      "health-check",
      "job-gap-scan",
      "memory-compaction",
      "qa-sweep",
      "quality-watch",
      "release-state",
      "repo-graph",
      "research",
      "skills-research",
      "system-audit",
      "work-briefing",
    ])
    expect(marked.filter((entry) => entry.kind === "act").map((entry) => entry.slug)).toEqual([
      "bug",
      "chore",
      "feature",
      "fix",
      "fix-ci",
      "init",
      "merge",
      "npm-publish",
      "plan",
      "preview-build",
      "release-deploy",
      "release-merge",
      "release-prepare",
      "release-publish",
      "reproduce",
      "resolve",
      "revert",
      "sync",
      "task-memorize",
      "vercel-dev-deploy",
      "vercel-production-deploy",
    ])
    expect(marked.filter((entry) => entry.kind === "verify").map((entry) => entry.slug)).toEqual([
      "approval-gate",
      "ceo-performance-review",
      "ci-health",
      "design-review",
      "duty-review",
      "job-live-verify",
      "plan-verify",
      "probe-skill",
      "qa",
      "qa-goal",
      "qa-verify",
      "review",
      "task-verifier",
      "ui-review",
      "verify-deployment-live",
      "verify-package-published",
      "verify-release-pr-ready",
    ])
  })
})

function referencedExecutables(raw: { executable?: string; executables?: string[] }): string[] {
  if (typeof raw.executable === "string" && raw.executable.trim()) return [raw.executable.trim()]
  if (Array.isArray(raw.executables)) return raw.executables.map((item) => item.trim()).filter(Boolean)
  return []
}
