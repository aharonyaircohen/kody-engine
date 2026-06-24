import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { loadProfile, validateScriptReferences } from "../../src/profile.js"
import { resolveAgentResponsibilityAction } from "../../src/registry.js"
import { allScriptNames } from "../../src/scripts/index.js"

describe("agent-factory profile", () => {
  it("loads the agentAction and validates script references", () => {
    const profile = loadProfile(path.resolve(__dirname, "../../src/agent-actions/agent-factory/profile.json"))

    expect(profile.name).toBe("agent-factory")
    expect(profile.action).toBe("agent-factory")
    expect(profile.capabilityKind).toBe("act")
    expect(profile.lifecycle).toBeUndefined()
    expect(profile.scripts.preflight.map((entry) => entry.script)).toEqual(["loadIssueContext", "composePrompt"])
    expect(profile.scripts.postflight.map((entry) => entry.script)).toEqual([
      "parseAgentResult",
      "openAgentFactoryStatePr",
    ])
    expect(profile.scripts.postflight.map((entry) => entry.script)).not.toContain("commitAndPush")
    expect(profile.scripts.postflight.map((entry) => entry.script)).not.toContain("ensurePr")
    expect(profile.claudeCode.tools).not.toContain("Bash")
    expect(profile.claudeCode.tools).not.toContain("Write")
    expect(profile.claudeCode.tools).not.toContain("Edit")
    expect(validateScriptReferences(profile, allScriptNames)).toEqual([])
  })

  it("loads the built-in public responsibility", () => {
    const profile = loadProfile(path.resolve(__dirname, "../../src/agent-responsibilities/agent-factory/profile.json"))

    expect(profile.name).toBe("agent-factory")
    expect(profile.action).toBe("agent-factory")
    expect(profile.agentAction).toBe("agent-factory")
    expect(profile.capabilityKind).toBe("act")

    expect(resolveAgentResponsibilityAction("agent-factory")?.capabilityKind).toBe("act")
  })
})
