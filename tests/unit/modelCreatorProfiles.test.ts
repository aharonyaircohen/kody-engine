import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { loadProfile, validateScriptReferences } from "../../src/profile.js"
import { resolveCapabilityAction } from "../../src/registry.js"
import { allScriptNames } from "../../src/scripts/index.js"

const creators = [
  {
    name: "agent-creator",
    docs: ["docs/agents.md"],
    owns: "identity",
    notOwn: "tasks",
  },
  {
    name: "capability-creator",
    docs: ["docs/capabilities.md", "docs/capability-kind-map.md", "docs/executables.md"],
    owns: "ability",
    notOwn: "who requested it",
  },
  {
    name: "goal-creator",
    docs: ["docs/goals.md", "docs/jobs-model.md", "docs/capabilities.md"],
    owns: "outcome",
    notOwn: "capability implementation",
  },
  {
    name: "loop-creator",
    docs: ["docs/jobs-model.md", "docs/engine-company.md", "docs/ledgers.md"],
    owns: "cadence",
    notOwn: "business completion",
  },
  {
    name: "workflow-creator",
    docs: ["docs/jobs-model.md", "docs/capabilities.md"],
    owns: "ordered capability steps",
    notOwn: "long-term progress",
  },
] as const

const executableRoot = path.resolve(__dirname, "../../src/executables")

describe("model creator profiles", () => {
  it("loads every creator as a safe issue-scoped primitive", () => {
    for (const creator of creators) {
      const profile = loadProfile(path.join(executableRoot, creator.name, "profile.json"))

      expect(profile.name).toBe(creator.name)
      expect(profile.action).toBe(creator.name)
      expect(profile.role).toBe("primitive")
      expect(profile.kind).toBe("oneshot")
      expect(profile.inputs).toEqual([
        {
          name: "issue",
          flag: "--issue",
          type: "int",
          required: true,
          describe: "GitHub issue number containing the focused model creation request.",
        },
      ])
      expect(profile.scripts.preflight.map((entry) => entry.script)).toEqual(["loadIssueContext", "composePrompt"])
      expect(profile.scripts.postflight.map((entry) => entry.script)).toEqual([
        "parseAgentResult",
        "validateAgentFactoryBundle",
        "openAgentFactoryStatePr",
      ])
      expect(profile.claudeCode.tools).toEqual(["Read", "Grep", "Glob"])
      expect(profile.claudeCode.tools).not.toContain("Bash")
      expect(profile.claudeCode.tools).not.toContain("Write")
      expect(profile.claudeCode.tools).not.toContain("Edit")
      expect(validateScriptReferences(profile, allScriptNames)).toEqual([])
    }
  })

  it("exposes every creator as a built-in capability action", () => {
    for (const creator of creators) {
      expect(resolveCapabilityAction(creator.name)).toMatchObject({
        action: creator.name,
        capability: creator.name,
        executable: creator.name,
        source: "builtin",
      })
    }
  })

  it("pins each creator prompt to its model docs and boundary", () => {
    for (const creator of creators) {
      const prompt = fs.readFileSync(path.join(executableRoot, creator.name, "prompt.md"), "utf-8")

      for (const doc of creator.docs) expect(prompt).toContain(doc)
      expect(prompt).toContain(creator.owns)
      expect(prompt).toContain(creator.notOwn)
      expect(prompt).toContain('"docsUsed"')
      expect(prompt).toContain('"model"')
      expect(prompt).toContain("PR_SUMMARY")
      expect(prompt).toContain("Your only mutation channel is `PR_SUMMARY.files`")
    }
  })

  it("keeps agent-factory constrained by the per-model creator contracts", () => {
    const prompt = fs.readFileSync(path.join(executableRoot, "agent-factory", "prompt.md"), "utf-8")

    for (const creator of creators) {
      expect(prompt).toContain(creator.name)
      for (const doc of creator.docs) expect(prompt).toContain(doc)
    }
    expect(prompt).toContain("Do not let the factory invent mixed-responsibility files.")
    expect(prompt).toContain("still list the referenced doc paths")
    expect(prompt).toContain("modelCreatorContractsUsed")
  })
})
