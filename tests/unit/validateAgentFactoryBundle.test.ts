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
        docsUsed: ["docs/capabilities.md", "docs/capability-kind-map.md", "docs/capability-implementations.md"],
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

  it("accepts a display name when capability profile slug matches the model", () => {
    const named = bundle({
      files: [
        {
          path: "capabilities/verify-production-live/profile.json",
          content: JSON.stringify({
            slug: "verify-production-live",
            name: "Verify Production Live",
            capabilityKind: "verify",
          }),
        },
        {
          path: "capabilities/verify-production-live/capability.md",
          content: "# Verify Production Live\n",
        },
      ],
    })

    expect(validateModelBundle(named, "capability-creator")).toEqual([])
  })

  it("accepts workflow profiles with top-level steps", () => {
    const workflow = bundle({
      model: {
        kind: "workflow",
        slug: "docs-proof-workflow",
        docsUsed: ["docs/jobs-model.md", "docs/capabilities.md"],
        steps: [{ capability: "inspect", reason: "inspect first" }],
      },
      files: [
        {
          path: "capabilities/docs-proof-workflow/profile.json",
          content: JSON.stringify({
            name: "docs-proof-workflow",
            steps: [{ capability: "inspect", reason: "inspect first" }],
          }),
        },
      ],
    })

    expect(validateModelBundle(workflow, "workflow-creator")).toEqual([])
  })

  it("accepts agent loops stored under goals state paths", () => {
    const loop = bundle({
      model: {
        kind: "agentLoop",
        slug: "daily-docs-proof-loop",
        docsUsed: ["docs/jobs-model.md", "docs/engine-company.md", "docs/ledgers.md"],
        cadence: "1d",
        wakeTarget: { type: "goal", slug: "docs-proof" },
      },
      files: [
        {
          path: "goals/daily-docs-proof-loop/state.json",
          content: JSON.stringify({ state: "active" }),
        },
      ],
    })

    expect(validateModelBundle(loop, "loop-creator")).toEqual([])
  })

  it("accepts agent loops stored under current capability state paths", () => {
    const loop = bundle({
      model: {
        kind: "agentLoop",
        slug: "daily-docs-proof-loop",
        docsUsed: ["docs/jobs-model.md", "docs/engine-company.md", "docs/ledgers.md"],
        cadence: "1d",
        wakeTarget: { type: "goal", slug: "docs-proof" },
      },
      files: [
        {
          path: ".kody/capabilities/daily-docs-proof-loop/state.json",
          content: JSON.stringify({ version: 1, cursor: "idle", done: false }),
        },
      ],
    })

    expect(validateModelBundle(loop, "loop-creator")).toEqual([])
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
            docsUsed: ["docs/capabilities.md", "docs/capability-kind-map.md", "docs/capability-implementations.md"],
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
            docsUsed: ["docs/capabilities.md", "docs/capability-kind-map.md", "docs/capability-implementations.md"],
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

  it("accepts factory bundles when canonical goal and loop facts are present in files", () => {
    const factory = bundle({
      modelCreatorContractsUsed: [
        "agent-creator",
        "goal-creator",
        "loop-creator",
        "workflow-creator",
        "capability-creator",
      ],
      models: [
        {
          kind: "agent",
          slug: "docs-proof-agent",
          docsUsed: ["docs/agents.md"],
          doesNotOwn: ["tasks", "schedules", "tools", "outputs", "workflows", "goals", "loops"],
        },
        {
          kind: "capability",
          slug: "docs-proof-signal",
          capabilityKind: "act",
          ability: "verify documentation correctness",
          docsUsed: ["docs/capabilities.md", "docs/capability-kind-map.md", "docs/capability-implementations.md"],
          inputs: [],
          outputs: [],
          allowedActions: [],
          forbiddenActions: [],
          doesNotOwn: ["agent identity", "goal progress", "loop cadence", "workflow order"],
        },
        {
          kind: "goal",
          slug: "docs-proof-goal",
          docsUsed: ["docs/goals.md", "docs/jobs-model.md", "docs/capabilities.md"],
          allowedCapabilities: ["docs-proof-signal"],
          doesNotOwn: ["capability implementation", "agent identity", "loop cadence"],
        },
        {
          kind: "workflow",
          slug: "docs-proof-workflow",
          docsUsed: ["docs/jobs-model.md", "docs/capabilities.md"],
          steps: ["docs-proof-signal"],
        },
        {
          kind: "agentLoop",
          slug: "daily-docs-proof-loop",
          docsUsed: ["docs/jobs-model.md", "docs/engine-company.md", "docs/ledgers.md"],
          cadence: "daily",
          target: "docs-proof-goal",
        },
      ],
      files: [
        {
          path: "agents/docs-proof-agent.md",
          content: "---\nidentity:\n  role: docs proof\njudgment:\n  scope: docs\nboundaries: []\n",
        },
        {
          path: "capabilities/docs-proof-signal/profile.json",
          content: JSON.stringify({
            name: "docs-proof-signal",
            capabilityKind: "act",
          }),
        },
        {
          path: "capabilities/docs-proof-signal/capability.md",
          content: "# Docs Proof Signal\n",
        },
        {
          path: "goals/templates/docs-proof-goal/state.json",
          content: JSON.stringify({
            outcome: "Documentation is verified",
            evidence: ["verification findings"],
            allowedCapabilities: ["docs-proof-signal"],
          }),
        },
        {
          path: "capabilities/docs-proof-workflow/profile.json",
          content: JSON.stringify({
            name: "docs-proof-workflow",
            workflow: { steps: [{ capability: "docs-proof-signal" }] },
          }),
        },
        {
          path: "loops/daily-docs-proof-loop/state.json",
          content: JSON.stringify({
            loop: {
              cadence: "daily",
              target: "docs-proof-goal",
            },
          }),
        },
      ],
    })

    expect(validateModelBundle(factory, "agent-factory")).toEqual([])
  })
})
