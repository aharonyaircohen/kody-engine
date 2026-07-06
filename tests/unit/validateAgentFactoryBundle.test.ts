import { describe, expect, it } from "vitest"
import { parseAgentFactoryBundle } from "../../src/scripts/openAgentFactoryStatePr.js"
import { validateModelBundle } from "../../src/scripts/validateAgentFactoryBundle.js"

function bundle(overrides: Record<string, unknown> = {}) {
  return parseAgentFactoryBundle(
    JSON.stringify({
      title: "Create production verification capability",
      summary: "Adds one capability model.",
      model: {
        kind: "capability",
        slug: "verify-production-live",
        capabilityKind: "verify",
        ability: "verify production deployment is live",
        docsUsed: ["docs/capabilities.md", "docs/capability-kind-map.md", "docs/executables.md"],
        inputs: ["url", "expectedVersion"],
        outputs: ["passed", "evidence", "blockers"],
        allowedActions: ["read deployment URL"],
        forbiddenActions: ["deploy", "merge", "modify repo"],
        doesNotOwn: ["agent identity", "goal progress", "loop cadence", "workflow order"],
      },
      files: [
        {
          path: "capabilities/verify-production-live/profile.json",
          content: JSON.stringify({
            name: "verify-production-live",
            action: "verify-production-live",
            capabilityKind: "verify",
            role: "primitive",
            kind: "oneshot",
            describe: "Verify production deployment is live.",
            inputs: [],
            claudeCode: {
              model: "inherit",
              permissionMode: "default",
              tools: ["Read"],
              hooks: [],
              skills: [],
              commands: [],
              subagents: [],
              plugins: [],
              mcpServers: [],
            },
            cliTools: [],
            scripts: { preflight: [], postflight: [] },
          }),
        },
        {
          path: "capabilities/verify-production-live/capability.md",
          content: "# Verify Production Live\n",
        },
      ],
      ...overrides,
    }),
  )
}

describe("validateModelBundle", () => {
  it("accepts a focused capability creator bundle", () => {
    expect(validateModelBundle(bundle(), "capability-creator")).toEqual([])
  })

  it("rejects capability bundles shaped by agent wiring", () => {
    const bad = bundle({
      files: [
        {
          path: "capabilities/verify-production-live/profile.json",
          content: JSON.stringify({
            name: "verify-production-live",
            capabilityKind: "verify",
            agent: "qa",
          }),
        },
        {
          path: "capabilities/verify-production-live/capability.md",
          content: "# Verify Production Live\n",
        },
      ],
    })

    expect(validateModelBundle(bad, "capability-creator")).toContain(
      "capability profile must not set agent; agent wiring belongs outside capability creation",
    )
  })

  it("rejects a creator returning the wrong model kind", () => {
    const bad = bundle({
      model: {
        kind: "goal",
        slug: "verify-production-live",
        docsUsed: ["docs/goals.md", "docs/jobs-model.md", "docs/capabilities.md"],
      },
    })

    expect(validateModelBundle(bad, "capability-creator")).toContain(
      "capability-creator must output model.kind capability",
    )
  })

  it("requires factory bundles to declare the per-model contracts they used", () => {
    const failures = validateModelBundle(
      bundle({
        modelCreatorContractsUsed: ["capability-creator"],
        models: [
          {
            kind: "capability",
            slug: "verify-production-live",
            capabilityKind: "verify",
            ability: "verify production deployment is live",
            docsUsed: ["docs/capabilities.md", "docs/capability-kind-map.md", "docs/executables.md"],
            inputs: [],
            outputs: [],
            allowedActions: [],
            forbiddenActions: [],
            doesNotOwn: ["agent identity", "goal progress", "loop cadence", "workflow order"],
          },
        ],
      }),
      "agent-factory",
    )

    expect(failures).toContain("modelCreatorContractsUsed missing agent-creator")
    expect(failures).toContain("modelCreatorContractsUsed missing goal-creator")
    expect(failures).toContain("modelCreatorContractsUsed missing loop-creator")
    expect(failures).toContain("modelCreatorContractsUsed missing workflow-creator")
  })

  it("validates factory assembly references across models", () => {
    const failures = validateModelBundle(
      bundle({
        modelCreatorContractsUsed: [
          "agent-creator",
          "goal-creator",
          "loop-creator",
          "workflow-creator",
          "capability-creator",
        ],
        models: [
          {
            kind: "capability",
            slug: "verify-production-live",
            capabilityKind: "verify",
            ability: "verify production deployment is live",
            docsUsed: ["docs/capabilities.md", "docs/capability-kind-map.md", "docs/executables.md"],
            inputs: [],
            outputs: [],
            allowedActions: [],
            forbiddenActions: [],
            doesNotOwn: ["agent identity", "goal progress", "loop cadence", "workflow order"],
          },
          {
            kind: "workflow",
            slug: "release-verify-flow",
            docsUsed: ["docs/jobs-model.md", "docs/capabilities.md"],
            steps: [{ capability: "missing-capability", reason: "prove final deployment" }],
            doesNotOwn: ["long-term progress"],
          },
        ],
      }),
      "agent-factory",
    )

    expect(failures).toContain("workflow release-verify-flow references missing capability missing-capability")
  })
})
