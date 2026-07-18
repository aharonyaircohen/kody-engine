import { describe, expect, it } from "vitest"
import { parseAgencyModelProposal } from "../../src/scripts/openAgencyModelReviewPr.js"
import { validateModelBundle } from "../../src/scripts/validateAgencyModelProposal.js"

function bundle(overrides: Record<string, unknown> = {}) {
  return parseAgencyModelProposal(
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
  it("accepts a review-first company Intent bundle", () => {
    const intent = bundle({
      model: {
        kind: "intent",
        slug: "reliable-releases",
        docsUsed: ["docs/intents.md", "docs/engine-company.md"],
        direction: "Ship reliable releases without slowing routine delivery.",
        priority: 10,
        scope: { repos: ["owner/repo"], areas: ["release"] },
        principles: ["Evidence before production"],
        successMeasures: ["production deployment verified"],
        policy: { automation: { authority: "full-auto", requiresHumanFor: ["production"] } },
        status: "paused",
        doesNotOwn: ["operations", "goals", "loops", "capability implementation"],
      },
      files: [
        {
          path: "intents/reliable-releases/intent.json",
          content: JSON.stringify({
            version: 1,
            id: "reliable-releases",
            status: "paused",
            for: "Ship reliable releases without slowing routine delivery.",
            priority: 10,
            scope: { repos: ["owner/repo"], areas: ["release"] },
            principles: ["Evidence before production"],
            metrics: ["production deployment verified"],
            policy: { automation: { authority: "full-auto", requiresHumanFor: ["production"] } },
          }),
        },
      ],
    })

    expect(validateModelBundle(intent, "intent")).toEqual([])
  })

  it("accepts a proposed Operation bundle", () => {
    const operation = bundle({
      model: {
        kind: "operation",
        slug: "release-operations",
        docsUsed: ["docs/operations.md", "docs/engine-company.md"],
        responsibility: "Own reliable release outcomes.",
        doesNotOwn: ["company direction", "capability implementation", "runtime operation"],
        intentIds: ["reliable-releases"],
        goals: ["web-release"],
        loops: ["daily-web-release-loop"],
        status: "proposed",
      },
      files: [
        {
          path: "operations/release-operations/operation.json",
          content: JSON.stringify({
            version: 1,
            id: "release-operations",
            name: "Release Operations",
            responsibility: "Own reliable release outcomes.",
            doesNotOwn: ["company direction", "capability implementation", "runtime operation"],
            intentIds: ["reliable-releases"],
            goals: ["web-release"],
            loops: ["daily-web-release-loop"],
            status: "proposed",
          }),
        },
      ],
    })

    expect(validateModelBundle(operation, "operation")).toEqual([])
  })

  it("accepts an unprovisioned Operation proposal before Goals or Loops exist", () => {
    const operation = bundle({
      model: {
        kind: "operation",
        slug: "release-operations",
        docsUsed: ["docs/operations.md", "docs/engine-company.md"],
        responsibility: "Own reliable release outcomes.",
        doesNotOwn: ["company direction", "capability implementation", "runtime operation"],
        intentIds: ["reliable-releases"],
        goals: [],
        loops: [],
        status: "proposed",
      },
      files: [
        {
          path: "operations/release-operations/operation.json",
          content: JSON.stringify({
            version: 1,
            id: "release-operations",
            name: "Release Operations",
            responsibility: "Own reliable release outcomes.",
            doesNotOwn: ["company direction", "capability implementation", "runtime operation"],
            intentIds: ["reliable-releases"],
            goals: [],
            loops: [],
            status: "proposed",
          }),
        },
      ],
    })

    expect(validateModelBundle(operation, "operation")).toEqual([])
  })

  it("rejects creators that activate Intent or Operation proposals", () => {
    const intent = bundle({
      model: {
        kind: "intent",
        slug: "reliable-releases",
        docsUsed: ["docs/intents.md", "docs/engine-company.md"],
        direction: "Ship reliable releases.",
        priority: 10,
        scope: { repos: [], areas: ["release"] },
        principles: ["Evidence first"],
        successMeasures: ["release verified"],
        policy: {},
        status: "active",
        doesNotOwn: ["operations", "goals", "loops", "capability implementation"],
      },
      files: [
        {
          path: "intents/reliable-releases/intent.json",
          content: JSON.stringify({ version: 1, id: "reliable-releases", status: "active" }),
        },
      ],
    })

    expect(validateModelBundle(intent, "intent")).toContain("intent proposal status must be paused")
  })

  it("rejects an incomplete Intent file even when the model summary is complete", () => {
    const intent = bundle({
      model: {
        kind: "intent",
        slug: "reliable-releases",
        docsUsed: ["docs/intents.md", "docs/engine-company.md"],
        direction: "Ship reliable releases.",
        priority: 10,
        scope: { repos: [], areas: ["release"] },
        principles: ["Evidence first"],
        successMeasures: ["release verified"],
        policy: { automation: {} },
        status: "paused",
        doesNotOwn: ["operations", "goals", "loops", "capability implementation"],
      },
      files: [
        {
          path: "intents/reliable-releases/intent.json",
          content: JSON.stringify({ version: 1, id: "reliable-releases", status: "paused" }),
        },
      ],
    })

    expect(validateModelBundle(intent, "intent")).toContain("intent file must declare direction")
  })

  it("rejects an incomplete Operation file even when the model summary is complete", () => {
    const operation = bundle({
      model: {
        kind: "operation",
        slug: "release-operations",
        docsUsed: ["docs/operations.md", "docs/engine-company.md"],
        responsibility: "Own reliable release outcomes.",
        doesNotOwn: ["company direction"],
        intentIds: ["reliable-releases"],
        goals: ["web-release"],
        loops: [],
        status: "proposed",
      },
      files: [
        {
          path: "operations/release-operations/operation.json",
          content: JSON.stringify({ version: 1, id: "release-operations", status: "proposed" }),
        },
      ],
    })

    expect(validateModelBundle(operation, "operation")).toContain("operation file must declare responsibility")
  })

  it("accepts a focused capability creator bundle", () => {
    expect(validateModelBundle(bundle(), "capability")).toEqual([])
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

    expect(validateModelBundle(named, "capability")).toEqual([])
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
        { path: "capabilities/docs-proof-workflow/capability.md", content: "# Docs Proof Workflow\n" },
      ],
    })

    expect(validateModelBundle(workflow, "workflow")).toEqual([])
  })

  it("rejects workflow profiles without a capability body", () => {
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
          content: JSON.stringify({ name: "docs-proof-workflow", steps: [{ capability: "inspect" }] }),
        },
      ],
    })

    expect(validateModelBundle(workflow, "workflow")).toContain(
      "missing workflow capability body: capabilities/docs-proof-workflow/capability.md",
    )
  })

  it("accepts a complete agent-created graph with a bounded loop", () => {
    const steps = [
      {
        id: "inspect",
        capability: "inspect",
        next: [
          { to: "repair", when: { "facts.needsFix": true } },
          { to: "publish", default: true },
        ],
      },
      { id: "repair", capability: "repair", next: [{ to: "inspect", maxIterations: 3 }] },
      { id: "publish", capability: "publish" },
    ]
    const workflow = bundle({
      model: {
        kind: "workflow",
        slug: "safe-workflow",
        docsUsed: ["docs/jobs-model.md", "docs/capabilities.md"],
        steps,
      },
      files: [
        {
          path: "capabilities/safe-workflow/profile.json",
          content: JSON.stringify({ name: "safe-workflow", workflow: { startAt: "inspect", steps } }),
        },
        { path: "capabilities/safe-workflow/capability.md", content: "# Safe Workflow\n" },
      ],
    })

    expect(validateModelBundle(workflow, "workflow")).toEqual([])
  })

  it.each([
    {
      name: "a missing destination",
      steps: [{ id: "inspect", capability: "inspect", next: "missing" }],
      failure: "connects to missing step",
    },
    {
      name: "an unbounded loop",
      steps: [
        { id: "inspect", capability: "inspect", next: "repair" },
        { id: "repair", capability: "repair", next: "inspect" },
      ],
      failure: "must set maxIterations",
    },
    {
      name: "a conditional branch without an otherwise path",
      steps: [
        { id: "inspect", capability: "inspect", next: [{ to: "repair", when: { "facts.needsFix": true } }] },
        { id: "repair", capability: "repair" },
      ],
      failure: "needs one default connection",
    },
  ])("rejects a workflow proposal with $name", ({ steps, failure }) => {
    const workflow = bundle({
      model: {
        kind: "workflow",
        slug: "unsafe-workflow",
        docsUsed: ["docs/jobs-model.md", "docs/capabilities.md"],
        steps,
      },
      files: [
        {
          path: "capabilities/unsafe-workflow/profile.json",
          content: JSON.stringify({ name: "unsafe-workflow", workflow: { steps } }),
        },
        { path: "capabilities/unsafe-workflow/capability.md", content: "# Unsafe Workflow\n" },
      ],
    })

    expect(validateModelBundle(workflow, "workflow").join("; ")).toContain(failure)
  })

  it("rejects workflow models that pretend capabilityKind can be workflow", () => {
    const workflow = bundle({
      model: {
        kind: "workflow",
        slug: "docs-proof-workflow",
        capabilityKind: "workflow",
        docsUsed: ["docs/jobs-model.md", "docs/capabilities.md"],
        steps: [{ capability: "inspect", reason: "inspect first" }],
      },
      files: [
        {
          path: "capabilities/docs-proof-workflow/profile.json",
          content: JSON.stringify({
            name: "docs-proof-workflow",
            workflow: { steps: [{ capability: "inspect", reason: "inspect first" }] },
          }),
        },
        { path: "capabilities/docs-proof-workflow/capability.md", content: "# Docs Proof Workflow\n" },
      ],
    })

    expect(validateModelBundle(workflow, "workflow")).toContain("workflow model must not declare capabilityKind")
  })

  it("rejects workflow profiles that pretend capabilityKind can be workflow", () => {
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
            capabilityKind: "workflow",
            workflow: { steps: [{ capability: "inspect", reason: "inspect first" }] },
          }),
        },
        { path: "capabilities/docs-proof-workflow/capability.md", content: "# Docs Proof Workflow\n" },
      ],
    })

    expect(validateModelBundle(workflow, "workflow")).toContain("workflow profile must not declare capabilityKind")
  })

  it("rejects workflow fields that the engine would otherwise ignore", () => {
    const steps = [
      {
        id: "inspect",
        capability: "inspect",
        produces: ["health"],
        next: [{ to: "publish", default: true, handoff: "health" }],
      },
      { id: "publish", capability: "publish" },
    ]
    const workflow = bundle({
      model: {
        kind: "workflow",
        slug: "strict-workflow",
        docsUsed: ["docs/jobs-model.md", "docs/capabilities.md"],
        steps,
      },
      files: [
        {
          path: "capabilities/strict-workflow/profile.json",
          content: JSON.stringify({ name: "strict-workflow", workflow: { steps } }),
        },
        { path: "capabilities/strict-workflow/capability.md", content: "# Strict Workflow\n" },
      ],
    })

    expect(validateModelBundle(workflow, "workflow").join("; ")).toContain("field produces is not supported")
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

    expect(validateModelBundle(loop, "agentLoop")).toEqual([])
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
          path: ".kody-engine/definitions/capabilities/daily-docs-proof-loop/state.json",
          content: JSON.stringify({ version: 1, cursor: "idle", done: false }),
        },
      ],
    })

    expect(validateModelBundle(loop, "agentLoop")).toEqual([])
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

    expect(validateModelBundle(bad, "capability")).toContain(
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

    expect(validateModelBundle(bad, "capability")).toContain("proposal must output model.kind capability")
  })
})
