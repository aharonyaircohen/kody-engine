import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { loadProfile, validateScriptReferences } from "../../src/profile.js"
import { resolveCapabilityAction } from "../../src/registry.js"
import { allScriptNames } from "../../src/scripts/index.js"

describe("agent-factory profile", () => {
  it("loads the executable and validates script references", () => {
    const profile = loadProfile(path.resolve(__dirname, "../../src/executables/agent-factory/profile.json"))

    expect(profile.name).toBe("agent-factory")
    expect(profile.action).toBe("agent-factory")
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

  it("loads the built-in public capability", () => {
    const profile = loadProfile(path.resolve(__dirname, "../../src/capabilities/agent-factory/profile.json"))

    expect(profile.name).toBe("agent-factory")
    expect(profile.action).toBe("agent-factory")
    expect(profile.executable).toBe("agent-factory")

    expect(resolveCapabilityAction("agent-factory")).toMatchObject({
      action: "agent-factory",
      capability: "agent-factory",
      executable: "agent-factory",
    })
  })
})
