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
      ],
    })

    expect(validateModelBundle(workflow, "workflow")).toEqual([])
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
      ],
    })

    expect(validateModelBundle(workflow, "workflow")).toContain("workflow profile must not declare capabilityKind")
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
          path: ".kody/capabilities/daily-docs-proof-loop/state.json",
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
