import { describe, expect, it } from "vitest"
import { normalizeCompanyIntent } from "../../src/companyIntent.js"

describe("company intent model", () => {
  it("normalizes release-confidence intent with metrics", () => {
    const intent = normalizeCompanyIntent("intents/release-confidence/intent.json", {
      id: "release-confidence",
      status: "active",
      for: "safe, boring releases",
      description: "Prefer evidence-backed releases and avoid risky shortcuts.",
      priority: 1,
      posture: "confidence",
      scope: { repos: ["Kody-Dashboard"], areas: ["release"] },
      principles: ["prefer verified deploys over fast deploys"],
      metrics: ["ciGreen", "previewHealthy"],
      policy: {
        release: {
          cadence: "manual",
          qaDepth: "strict",
          blockerLevel: "strict",
          approval: "before-production",
        },
        automation: {
          authority: "full-auto",
          maxConcurrentGoals: 1,
          maxDailyActions: 6,
          requiresHumanFor: ["production-publish"],
        },
      },
      portfolio: {
        goals: ["publish-current-release"],
        loops: ["release-health-loop"],
        capabilities: ["ci-health"],
      },
      manager: { agent: "cto", loop: "agency-architect-loop", capability: "agency-architect", reviewEvery: "1d" },
      createdAt: "2026-06-24T00:00:00Z",
      updatedAt: "2026-06-24T00:00:00Z",
    })

    expect(intent).toMatchObject({
      id: "release-confidence",
      status: "active",
      for: "safe, boring releases",
      description: "Prefer evidence-backed releases and avoid risky shortcuts.",
      posture: "confidence",
      metrics: ["ciGreen", "previewHealthy"],
      manager: { agent: "cto", loop: "agency-architect-loop", capability: "agency-architect" },
    })
  })

  it("defaults missing policy to bounded full-auto CTO management", () => {
    const intent = normalizeCompanyIntent("intents/code-health/intent.json", {
      id: "code-health",
      for: "healthy codebase",
    })

    expect(intent.policy.automation).toEqual({
      authority: "full-auto",
      maxConcurrentGoals: 1,
      maxDailyActions: 6,
      requiresHumanFor: [],
    })
    expect(intent.manager.agent).toBe("cto")
  })
})
