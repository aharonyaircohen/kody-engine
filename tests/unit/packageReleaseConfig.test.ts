import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { loadConfig } from "../../src/config.js"
import { readLoopDefinition } from "../../src/loopDefinitions.js"

describe("package release loop configuration", () => {
  it("activates the Store package release bundle", () => {
    const config = loadConfig(process.cwd())
    const raw = JSON.parse(readFileSync("kody.config.json", "utf8"))

    expect(config.company?.activeGoals).toBeUndefined()
    expect(raw.company.activeWorkflows).toContain("package-release")
    expect(config.company?.activeCapabilities).toEqual(
      expect.arrayContaining(["release-prepare", "release-validate", "release-merge", "npm-publish"]),
    )
    expect(config.release?.validation?.workflow).toBe("ci.yml")
  })

  it("allows the release workflow to dispatch exact-branch validation", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8")

    expect(workflow).toMatch(/workflow_dispatch:/)
  })

  it("enables the repository-owned daily package release loop", () => {
    const loop = readLoopDefinition(process.cwd(), "daily-package-release-loop")

    expect(loop).toMatchObject({
      id: "daily-package-release-loop",
      enabled: true,
      trigger: { type: "schedule", every: "1d" },
      target: { kind: "workflow", id: "package-release" },
    })
  })
})
