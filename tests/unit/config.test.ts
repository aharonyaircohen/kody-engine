import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import {
  litellmModelGroup,
  loadConfig,
  needsLitellmProxy,
  parseModelRuntimeConfig,
  parseProviderModel,
  providerApiKeyEnvVar,
} from "../../src/config.js"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-test-"))
}

function writeConfig(dir: string, contents: unknown): void {
  fs.writeFileSync(path.join(dir, "kody.config.json"), JSON.stringify(contents))
}

describe("config: parseProviderModel", () => {
  it("parses 'provider/model' correctly", () => {
    expect(parseProviderModel("minimax/MiniMax-M3")).toEqual({
      provider: "minimax",
      model: "MiniMax-M3",
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

describe("config: parseModelRuntimeConfig", () => {
  it("uses MODEL as the legacy fallback when no runtime config is supplied", () => {
    expect(parseModelRuntimeConfig("minimax/MiniMax-M3", undefined)).toEqual({
      provider: "minimax",
      model: "MiniMax-M3",
    })
  })

  it("uses the dashboard model config for OpenAI-compatible endpoints", () => {
    const model = parseModelRuntimeConfig(
      "minimax/MiniMax-M3",
      JSON.stringify({
        spec: "minimax/MiniMax-M3",
        provider: "custom",
        protocol: "openai",
        baseURL: "https://api.minimax.io/v1",
        modelName: "MiniMax-M3",
        apiKeyEnvVar: "MINIMAX_API_KEY",
      }),
    )

    expect(model).toEqual({
      provider: "custom",
      model: "MiniMax-M3",
      protocol: "openai",
      baseURL: "https://api.minimax.io/v1",
      apiKeyEnvVar: "MINIMAX_API_KEY",
      litellmProvider: "openai",
      spec: "minimax/MiniMax-M3",
    })
    expect(litellmModelGroup(model)).toBe("minimax/MiniMax-M3")
  })

  it("throws a clear error for invalid dashboard model config JSON", () => {
    expect(() => parseModelRuntimeConfig("minimax/MiniMax-M3", "{")).toThrow(/KODY_MODEL_CONFIG is invalid JSON/)
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

  it("preserves agent.perImplementation model overrides", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: {
        model: "claude/base",
        perImplementation: { classify: "claude/haiku", plan: "claude/opus", bogus: "", nope: 5 },
      },
    })
    const cfg = loadConfig(dir)
    // Valid string entries survive; empty-string and non-string entries drop.
    expect(cfg.agent.perImplementation).toEqual({ classify: "claude/haiku", plan: "claude/opus" })
  })

  it("omits perImplementation entirely when absent or all-invalid", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/base", perImplementation: { x: "" } },
    })
    expect(loadConfig(dir).agent.perImplementation).toBeUndefined()
  })

  it("preserves agent.perImplementationReasoningEffort overrides", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: {
        model: "claude/base",
        perImplementationReasoningEffort: { run: "high", review: "medium", classify: "off", bogus: "nuclear" },
      },
    })
    expect(loadConfig(dir).agent.perImplementationReasoningEffort).toEqual({
      run: "high",
      review: "medium",
      classify: "off",
    })
  })

  it("omits perImplementationReasoningEffort when absent or all-invalid", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/base", perImplementationReasoningEffort: { run: "" } },
    })
    expect(loadConfig(dir).agent.perImplementationReasoningEffort).toBeUndefined()
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

  it("preserves generic release production verification config", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      release: {
        releaseBranch: "main",
        allowAdminMerge: true,
        productionUrl: "https://www.example.com",
        smokeCommand: "pnpm smoke",
      },
    })

    expect(loadConfig(dir).release).toMatchObject({
      releaseBranch: "main",
      allowAdminMerge: true,
      productionUrl: "https://www.example.com",
      smokeCommand: "pnpm smoke",
    })
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

  it("loads defaultImplementation when set", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      defaultImplementation: "orchestrator-plan-build-review",
    })
    expect(loadConfig(dir).defaultImplementation).toBe("orchestrator-plan-build-review")
  })

  it("defaultImplementation defaults to 'run' when absent", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
    })
    expect(loadConfig(dir).defaultImplementation).toBe("run")
  })

  it("defaultImplementation defaults to 'run' when empty string", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      defaultImplementation: "",
    })
    expect(loadConfig(dir).defaultImplementation).toBe("run")
  })

  it("defaultImplementation defaults to 'run' when non-string", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      defaultImplementation: 42,
    })
    expect(loadConfig(dir).defaultImplementation).toBe("run")
  })

  it("loads repository Capability to Implementation bindings", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      execution: {
        capabilityBindings: {
          "build-knowledge-graph": "graphify-script",
        },
      },
    })
    expect(loadConfig(dir).execution).toEqual({
      capabilityBindings: {
        "build-knowledge-graph": "graphify-script",
      },
    })
  })

  it("loads defaultPrImplementation when set", () => {
    const dir = tmpDir()
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: { model: "m/x" },
      defaultPrImplementation: "sync",
    })
    expect(loadConfig(dir).defaultPrImplementation).toBe("sync")
  })

  it("omits defaultPrImplementation when absent, empty, or non-string", () => {
    for (const value of [undefined, "", 42]) {
      const dir = tmpDir()
      writeConfig(dir, {
        github: { owner: "o", repo: "r" },
        agent: { model: "m/x" },
        ...(value === undefined ? {} : { defaultPrImplementation: value }),
      })
      expect(loadConfig(dir).defaultPrImplementation).toBeUndefined()
    }
  })

  it("does not accept retired implementation config keys as compatibility aliases", () => {
    const dir = tmpDir()
    const retiredPerModel = "perExec" + "utable"
    const retiredPerReasoning = "perExec" + "utableReasoningEffort"
    const retiredDefault = "defaultExec" + "utable"
    const retiredDefaultPr = "defaultPrExec" + "utable"
    writeConfig(dir, {
      github: { owner: "o", repo: "r" },
      agent: {
        model: "m/x",
        [retiredPerModel]: { run: "m/old-run" },
        [retiredPerReasoning]: { run: "high" },
      },
      [retiredDefault]: "old-run",
      [retiredDefaultPr]: "old-sync",
    })
    const cfg = loadConfig(dir)
    expect(cfg.agent.perImplementation).toBeUndefined()
    expect(cfg.agent.perImplementationReasoningEffort).toBeUndefined()
    expect(cfg.defaultImplementation).toBe("run")
    expect(cfg.defaultPrImplementation).toBeUndefined()
    expect(cfg).not.toHaveProperty(retiredDefault)
    expect(cfg).not.toHaveProperty(retiredDefaultPr)
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
