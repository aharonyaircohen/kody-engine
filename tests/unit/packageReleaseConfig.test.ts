import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { loadConfig } from "../../src/config.js"

describe("package release loop configuration", () => {
  it("activates the Store package release bundle", () => {
    const config = loadConfig(process.cwd())

    expect(config.company?.activeGoals).toContain("daily-package-release-loop")
    expect(config.company?.activeCapabilities).toEqual(
      expect.arrayContaining(["release-prepare", "release-validate", "release-merge", "npm-publish"]),
    )
    expect(config.release?.validation?.workflow).toBe("ci.yml")
  })

  it("allows the release workflow to dispatch exact-branch validation", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8")

    expect(workflow).toMatch(/workflow_dispatch:/)
  })
})
