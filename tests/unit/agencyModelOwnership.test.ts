import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { resolveCapabilityAction, resolveImplementation } from "../../src/registry.js"
import { allScriptNames } from "../../src/scripts/index.js"

const modelActions = [
  "agent-factory",
  "agent-creator",
  "capability-creator",
  "goal-creator",
  "loop-creator",
  "workflow-creator",
] as const

describe("agency model ownership", () => {
  it("does not bundle agency structure or model creators in the engine", () => {
    const capabilityRoot = path.resolve(__dirname, "../../src/capabilities")
    const implementationRoot = path.resolve(__dirname, "../../src/implementations")

    for (const action of modelActions) {
      expect(fs.existsSync(path.join(capabilityRoot, action, "profile.json"))).toBe(false)
      expect(fs.existsSync(path.join(implementationRoot, action, "profile.json"))).toBe(false)
      expect(resolveImplementation(action, implementationRoot)).toBeNull()
    }
  })

  it("does not expose a central factory as an engine capability", () => {
    process.env.KODY_COMPANY_STORE = "off"
    try {
      expect(resolveCapabilityAction("agent-factory")).toBeNull()
    } finally {
      delete process.env.KODY_COMPANY_STORE
    }
  })

  it("keeps generic model proposal validation and review delivery in the engine", () => {
    expect(allScriptNames).toContain("validateAgencyModelProposal")
    expect(allScriptNames).toContain("openAgencyModelReviewPr")
    expect(allScriptNames).not.toContain("validateAgentFactoryBundle")
    expect(allScriptNames).not.toContain("openAgentFactoryStatePr")
  })
})
