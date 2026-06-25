import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { loadConfig, needsLitellmProxy, parseProviderModel, providerApiKeyEnvVar } from "../../src/config.js"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-test-"))
}

function writeConfig(dir: string, contents: unknown): void {
  fs.writeFileSync(path.join(dir, "kody.config.json"), JSON.stringify(contents))
}

describe("config: parseProviderModel", () => {
  it("parses 'provider/model' correctly", () => {
    expect(parseProviderModel("minimax/MiniMax-M2.7-highspeed")).toEqual({
      provider: "minimax",
      model: "MiniMax-M2.7-highspeed",
    })
  })

  it("throws on missing slash", () => {
    expect(() => parseProviderModel("badmodel")).toThrow(/Invalid model spec/)
  })

  it("throws on trailing slash", () => {
    expect(() => parseProviderModel("provider/")).toThrow(/Invalid model spec/)
  })

  it("preserves slashes inside model name", () => {
    expect(parseProviderModel("a/b/c")).toEqual({ provider: "a", model: "b/c" })
  })
})

describe("config: needsLitellmProxy / providerApiKeyEnvVar", () => {
  it("anthropic providers do not need proxy", () => {
    expect(needsLitellmProxy({ provider: "claude", model: "x" })).toBe(false)
    expect(needsLitellmProxy({ provider: "anthropic", model: "x" })).toBe(false)
  })

  it("other providers need proxy", () => {
    expect(needsLitellmProxy({ provider: "minimax", model: "x" })).toBe(true)
  })

  it("derives env var name correctly", () => {
    expect(providerApiKeyEnvVar("claude")).toBe("ANTHROPIC_API_KEY")
    expect(providerApiKeyEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY")
    expect(providerApiKeyEnvVar("minimax")).toBe("MINIMAX_API_KEY")
    expect(providerApiKeyEnvVar("openai")).toBe("OPENAI_API_KEY")
  })
})

describe("config: loadConfig", () => {
  it("loads minimal valid config", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "minimax/m" },
    })
    const cfg = loadConfig(dir)
    expect(cfg.github.owner).toBe("o")
    expect(cfg.agent.model).toBe("minimax/m")
    expect(cfg.git.defaultBranch).toBe("main")
    expect(cfg.state).toEqual({ repo: "https://github.com/o/kody-state", path: "r" })
  })

  it("accepts full GitHub URL for state repo", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "minimax/m" },
      state: { repo: "https://github.com/o/kody-state", path: "r" },
    })
    expect(loadConfig(dir).state).toEqual({ repo: "https://github.com/o/kody-state", path: "r" })
  })

  it("keeps legacy owner/repo state repo references readable", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "minimax/m" },
      state: { repo: "o/kody-state", path: "r" },
    })
    expect(loadConfig(dir).state).toEqual({ repo: "o/kody-state", path: "r" })
  })

  it("parses scheduled goal preferred runtime", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "minimax/m" },
      company: {
        activeGoals: [
          {
            template: "web-release",
            every: "1d",
            idPrefix: "web-release",
            preferredRunTime: { time: "10:00", timezone: "Asia/Jerusalem" },
          },
        ],
      },
    })
    expect(loadConfig(dir).company?.activeGoals).toEqual([
      {
        template: "web-release",
        every: "1d",
        idPrefix: "web-release",
        preferredRunTime: { time: "10:00", timezone: "Asia/Jerusalem" },
      },
    ])
  })

  it("throws when kody.config.json missing", () => {
    const dir = tmpDir()
    expect(() => loadConfig(dir)).toThrow(/not found/)
  })

  it("throws on malformed JSON", () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, "kody.config.json"), "{not json")
    expect(() => loadConfig(dir)).toThrow(/invalid JSON/)
  })

  it("throws when agent.model missing", () => {
    const dir = tmpDir()
    writeConfig(dir, { github: { owner: "o", repo: "r" }, agent: {} })
    expect(() => loadConfig(dir)).toThrow(/agent\.model/)
  })

  it("throws when github.owner missing", () => {
    const dir = tmpDir()
    writeConfig(dir, { github: { repo: "r" }, agent: { model: "m/x" } })
    expect(() => loadConfig(dir)).toThrow(/github\.owner/)
  })

  it("preserves agent.perAgentAction model overrides", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: {
        model: "claude/base",
        perAgentAction: { classify: "claude/haiku", plan: "claude/opus", bogus: "", nope: 5 },
      },
    })
    const cfg = loadConfig(dir)
    // Valid string entries survive; empty-string and non-string entries drop.
    expect(cfg.agent.perAgentAction).toEqual({ classify: "claude/haiku", plan: "claude/opus" })
  })

  it("omits perAgentAction entirely when absent or all-invalid", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/base", perAgentAction: { x: "" } },
    })
    expect(loadConfig(dir).agent.perAgentAction).toBeUndefined()
  })

  it("preserves agent.perAgentActionReasoningEffort overrides", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: {
        model: "claude/base",
        perAgentActionReasoningEffort: { run: "high", review: "medium", classify: "off", bogus: "nuclear" },
      },
    })
    expect(loadConfig(dir).agent.perAgentActionReasoningEffort).toEqual({
      run: "high",
      review: "medium",
      classify: "off",
    })
  })

  it("omits perAgentActionReasoningEffort when absent or all-invalid", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/base", perAgentActionReasoningEffort: { run: "" } },
    })
    expect(loadConfig(dir).agent.perAgentActionReasoningEffort).toBeUndefined()
  })

  it("preserves quality commands", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      quality: { typecheck: "tc", testUnit: "tu", lint: "ln" },
    })
    const cfg = loadConfig(dir)
    expect(cfg.quality).toEqual({ typecheck: "tc", testUnit: "tu", lint: "ln", format: "" })
  })

it("rejects local-file job state storage in kody.config.json", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      jobs: { stateBackend: "local-file" },
    })
    expect(() => loadConfig(dir)).toThrow(/local-file is not a supported durable storage mode/)
  })

  it("preserves string goal activations", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      company: { activeGoals: ["web-release", "web-release", " npm-release "] },
    })

    expect(loadConfig(dir).company?.activeGoals).toEqual(["web-release", "npm-release"])
  })

  it("loads scheduled goal template activations", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      company: {
        activeGoals: [
          "existing-goal",
          { template: "web-release", every: "1w", idPrefix: "web", facts: { issue: 123 } },
        ],
      },
    })

    expect(loadConfig(dir).company?.activeGoals).toEqual([
      "existing-goal",
      { template: "web-release", every: "1w", idPrefix: "web", facts: { issue: 123 } },
    ])
  })

  it("rejects invalid scheduled goal intervals", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      company: { activeGoals: [{ template: "web-release", every: "weekly" }] },
    })

    expect(() => loadConfig(dir)).toThrow(/activeGoals every/)
  })

  it("normalizes access.allowedAssociations to upper-case", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      access: { allowedAssociations: ["owner", "Member", "COLLABORATOR"] },
    })
    expect(loadConfig(dir).access?.allowedAssociations).toEqual(["OWNER", "MEMBER", "COLLABORATOR"])
  })

  it("defaults to team-only when access is omitted", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
    })
    expect(loadConfig(dir).access?.allowedAssociations).toEqual(["OWNER", "MEMBER", "COLLABORATOR"])
  })

  it("treats an explicit empty access.allowedAssociations as gate disabled (open)", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      access: { allowedAssociations: [] },
    })
    expect(loadConfig(dir).access?.allowedAssociations).toEqual([])
  })

  it("throws on an invalid association value", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      access: { allowedAssociations: ["MEMBERS"] },
    })
    expect(() => loadConfig(dir)).toThrow(/access\.allowedAssociations contains "MEMBERS"/)
  })

  it("loads defaultAgentAction when set", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      defaultAgentAction: "orchestrator-plan-build-review",
    })
    expect(loadConfig(dir).defaultAgentAction).toBe("orchestrator-plan-build-review")
  })

  it("defaultAgentAction defaults to 'run' when absent", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
    })
    expect(loadConfig(dir).defaultAgentAction).toBe("run")
  })

  it("defaultAgentAction defaults to 'run' when empty string", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      defaultAgentAction: "",
    })
    expect(loadConfig(dir).defaultAgentAction).toBe("run")
  })

  it("defaultAgentAction defaults to 'run' when non-string", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      defaultAgentAction: 42,
    })
    expect(loadConfig(dir).defaultAgentAction).toBe("run")
  })

  it("loads defaultPrAgentAction when set", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      defaultPrAgentAction: "sync",
    })
    expect(loadConfig(dir).defaultPrAgentAction).toBe("sync")
  })

  it("omits defaultPrAgentAction when absent, empty, or non-string", () => {
    for (const value of [undefined, "", 42]) {
      const dir = tmpDir()
      writeConfig(dir, {
        github: { owner: "o", repo: "r" },
        agent: { model: "m/x" },
        ...(value === undefined ? {} : { defaultPrAgentAction: value }),
      })
      expect(loadConfig(dir).defaultPrAgentAction).toBeUndefined()
    }
  })

  describe("agent.reasoningEffort", () => {
    it("preserves a valid reasoningEffort from the config file", () => {
      for (const value of ["off", "low", "medium", "high"]) {
        const dir = tmpDir()
        writeConfig(dir, {
          github: { owner: "o", repo: "r" },
          agent: { model: "m/x", reasoningEffort: value },
        })
        expect(loadConfig(dir).agent.reasoningEffort).toBe(value)
      }
    })

    it("omits reasoningEffort when absent (cheapest path default)", () => {
      const dir = tmpDir()
      writeConfig(dir, {
        github: { owner: "o", repo: "r" },
        agent: { model: "m/x" },
      })
      expect(loadConfig(dir).agent.reasoningEffort).toBeUndefined()
    })

    it("omits reasoningEffort when empty-string (engine sees no env override)", () => {
      const dir = tmpDir()
      writeConfig(dir, {
        github: { owner: "o", repo: "r" },
        agent: { model: "m/x", reasoningEffort: "" },
      })
      expect(loadConfig(dir).agent.reasoningEffort).toBeUndefined()
    })

    it("drops unknown reasoningEffort values to undefined instead of throwing", () => {
      // Forward-compatible: when we add a level in the future, old
      // engine versions reading a newer config should not crash —
      // they should silently ignore the unknown value.
      const dir = tmpDir()
      writeConfig(dir, {
        github: { owner: "o", repo: "r" },
        agent: { model: "m/x", reasoningEffort: "nuclear" },
      })
      expect(loadConfig(dir).agent.reasoningEffort).toBeUndefined()
    })
  })
})
