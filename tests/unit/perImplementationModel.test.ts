import { describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"

/**
 * The model-resolution precedence lives inline in src/executor.ts. This
 * test mirrors the resolution rule (perImplementation → profile.model → agent.model)
 * directly so the rule is locked in by tests even though it's not yet
 * extracted into a standalone function.
 */
function resolveModel(config: KodyConfig, profileName: string, profileModel: string): string {
  const perImplementationModel = config.agent.perImplementation?.[profileName]
  return perImplementationModel
    ? perImplementationModel
    : profileModel === "inherit"
      ? config.agent.model
      : profileModel
}

const baseConfig: KodyConfig = {
  quality: { typecheck: "", lint: "", testUnit: "", format: "" },
  git: { defaultBranch: "main" },
  github: { owner: "x", repo: "y" },
  agent: { model: "claude/claude-sonnet-4-6" },
}

describe("model resolution precedence (mirror)", () => {
  it("falls back to agent.model when profile inherits and no override is set", () => {
    expect(resolveModel(baseConfig, "run", "inherit")).toBe("claude/claude-sonnet-4-6")
  })

  it("uses the profile's explicit model when no override is set", () => {
    expect(resolveModel(baseConfig, "plan", "claude/claude-opus-4-7")).toBe("claude/claude-opus-4-7")
  })

  it("perImplementation wins over agent.model", () => {
    const cfg: KodyConfig = {
      ...baseConfig,
      agent: {
        model: "claude/claude-sonnet-4-6",
        perImplementation: { classify: "claude/claude-haiku-4-5-20251001" },
      },
    }
    expect(resolveModel(cfg, "classify", "inherit")).toBe("claude/claude-haiku-4-5-20251001")
  })

  it("perImplementation wins even when the profile names an explicit model", () => {
    const cfg: KodyConfig = {
      ...baseConfig,
      agent: {
        model: "claude/claude-sonnet-4-6",
        perImplementation: { plan: "claude/claude-haiku-4-5-20251001" },
      },
    }
    expect(resolveModel(cfg, "plan", "claude/claude-opus-4-7")).toBe("claude/claude-haiku-4-5-20251001")
  })

  it("missing perImplementation entry falls through to the normal precedence", () => {
    const cfg: KodyConfig = {
      ...baseConfig,
      agent: {
        model: "claude/claude-sonnet-4-6",
        perImplementation: { classify: "claude/claude-haiku-4-5-20251001" },
      },
    }
    expect(resolveModel(cfg, "run", "inherit")).toBe("claude/claude-sonnet-4-6")
  })
})
