import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { workflowIsObserveOnly } from "../../src/scripts/advanceManagedGoal.js"

let cwd: string

function writeCapability(slug: string, capabilityKind?: string): void {
  const dir = join(cwd, ".kody-engine", "definitions", "capabilities", slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "profile.json"),
    JSON.stringify({ name: slug, ...(capabilityKind ? { capabilityKind } : {}) }),
  )
  writeFileSync(join(dir, "capability.md"), `# ${slug}\n`)
}

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe("workflowIsObserveOnly", () => {
  it("is true when every step is observe or verify", () => {
    cwd = mkdtempSync(join(tmpdir(), "kody-observe-only-"))
    writeCapability("watch-ci", "observe")
    writeCapability("verify-ci", "verify")
    expect(workflowIsObserveOnly(["watch-ci", "verify-ci"], cwd)).toBe(true)
  })

  it("is false when any step acts or has no declared kind", () => {
    cwd = mkdtempSync(join(tmpdir(), "kody-observe-only-"))
    writeCapability("watch-ci", "observe")
    writeCapability("fix-ci", "act")
    writeCapability("mystery")
    expect(workflowIsObserveOnly(["watch-ci", "fix-ci"], cwd)).toBe(false)
    expect(workflowIsObserveOnly(["watch-ci", "mystery"], cwd)).toBe(false)
    expect(workflowIsObserveOnly([], cwd)).toBe(false)
    expect(workflowIsObserveOnly(["missing"], cwd)).toBe(false)
  })
})
