import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { loadConfig } from "../../src/config.js"

describe("self-management Observer pilot", () => {
  it("replaces Goal activation with the read-only Observer workflow", () => {
    const config = loadConfig(process.cwd())
    const raw = JSON.parse(readFileSync("kody.config.json", "utf8"))

    expect(config.company?.activeGoals).toBeUndefined()
    expect(raw.company.activeWorkflows).toEqual(
      expect.arrayContaining(["package-release", "web-release", "agency-observer"]),
    )
    expect(config.company?.activeCapabilities).toEqual(
      expect.arrayContaining(["repo-source-health", "observe-repo-ci", "observe-agency-flow"]),
    )
  })

  it("schedules the proven Observer to run daily", () => {
    expect(JSON.parse(readFileSync(".kody-engine/definitions/loops/agency-observer/loop.json", "utf8"))).toEqual({
      id: "agency-observer",
      trigger: { type: "schedule", every: "1d" },
      target: { kind: "workflow", id: "agency-observer" },
      input: {},
      enabled: true,
    })
  })

  it("uses the current generic launcher contract", () => {
    const launcher = readFileSync(".github/workflows/kody.yml", "utf8")

    expect(launcher).toContain("capability:")
    expect(launcher).toContain("message:")
    expect(launcher).toContain("runRequest:")
    expect(launcher).toContain("KODY_RUN_REQUEST_JSON: ${{ inputs.runRequest }}")
    expect(launcher).not.toContain("ALL_SECRETS:")
    expect(launcher).not.toContain("kody-engine ci")
  })
})
