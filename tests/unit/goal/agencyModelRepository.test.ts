import { describe, expect, it, vi } from "vitest"
import { AgencyModelRepository, goalProgressFromOutputs } from "../../../src/goal/agencyModelRepository.js"

const goal = {
  id: "refresh-graph",
  operationId: "knowledge",
  objective: {
    desiredState: "Graph is current",
    requiredEvidence: ["published"],
    scope: { include: {}, exclude: {} },
  },
  executionRef: { kind: "workflow" as const, id: "refresh-graph" },
}
const now = "2026-07-22T00:00:00.000Z"
const supportingDefinitions = [
  {
    tenantId: "acme/widgets",
    recordId: "quality",
    kind: "intent",
    schemaVersion: 1,
    data: {
      id: "quality",
      direction: "Keep knowledge trustworthy",
      priorities: ["evidence"],
      policy: {
        approval: "none",
        authority: { allow: ["refresh-graph"], deny: [] },
        budget: { maxRuns: 10, maxTokens: 10000, maxCostUsd: 10, maxDurationSeconds: 600 },
        maxConcurrentRuns: 1,
        riskyActions: [],
      },
      constraints: [],
    },
    createdAt: now,
  },
  {
    tenantId: "acme/widgets",
    recordId: "knowledge",
    kind: "operation",
    schemaVersion: 1,
    data: { id: "knowledge", name: "Knowledge", responsibility: "Keep knowledge current", intentIds: ["quality"] },
    createdAt: now,
  },
  {
    tenantId: "acme/widgets",
    recordId: "refresh-graph-workflow",
    kind: "workflow",
    schemaVersion: 1,
    data: {
      id: "refresh-graph",
      steps: [{ id: "build", capabilityRef: { kind: "capability", id: "build-graph" }, dependsOn: [] }],
    },
    createdAt: now,
  },
  {
    tenantId: "acme/widgets",
    recordId: "build-graph",
    kind: "capability",
    schemaVersion: 1,
    data: { id: "build-graph", action: "Build graph", input: "repository", output: "graph" },
    createdAt: now,
  },
] as const

describe("AgencyModelRepository", () => {
  it("derives Goal progress only from required evidence outputs", () => {
    expect(
      goalProgressFromOutputs(goal, "goal-revision", [
        {
          kind: "evidence",
          key: "published",
          value: true,
          runId: "run-1",
          producer: { kind: "capability", id: "build-knowledge-graph" },
          parentRef: {
            kind: "goal",
            id: "refresh-graph",
            revision: "goal-revision",
          },
          contract: "knowledge-graph",
          createdAt: now,
        },
        {
          kind: "fact",
          key: "unrelated",
          value: true,
          runId: "run-1",
          producer: { kind: "capability", id: "build-knowledge-graph" },
          parentRef: {
            kind: "goal",
            id: "refresh-graph",
            revision: "goal-revision",
          },
          contract: "knowledge-graph",
          createdAt: now,
        },
      ]),
    ).toBe(1)
  })

  it("ignores matching evidence produced for another Goal or revision", () => {
    expect(
      goalProgressFromOutputs(goal, "goal-revision", [
        {
          kind: "evidence",
          key: "published",
          value: true,
          runId: "run-other",
          producer: { kind: "capability", id: "build-knowledge-graph" },
          parentRef: {
            kind: "goal",
            id: "other-goal",
            revision: "other-revision",
          },
          contract: "knowledge-graph",
          createdAt: now,
        },
      ]),
    ).toBe(0)
  })

  it("loads and validates clean Definitions separately from mutable State", async () => {
    const backend = {
      listAgencyDefinitions: vi.fn().mockResolvedValue([
        ...supportingDefinitions,
        { tenantId: "acme/widgets", recordId: goal.id, kind: "goal", schemaVersion: 1, data: goal, createdAt: now },
      ]),
      getAgencyState: vi.fn().mockResolvedValue({
        tenantId: "acme/widgets",
        definitionId: goal.id,
        kind: "goal",
        schemaVersion: 1,
        data: { definitionId: goal.id, lifecycle: "active", progress: 0, blockers: [], updatedAt: now },
        updatedAt: now,
      }),
      putAgencyState: vi.fn(),
      appendAgencyOutput: vi.fn(),
      listAgencyOutputs: vi.fn().mockResolvedValue([]),
    }

    const records = await new AgencyModelRepository(backend, "acme/widgets").listManagedWork()

    expect(records).toHaveLength(1)
    expect(records[0]?.definition).toEqual(goal)
    expect(records[0]?.definition).not.toHaveProperty("version")
    expect(records[0]?.state).toMatchObject({ definitionId: goal.id, lifecycle: "active" })
    expect(backend.getAgencyState).toHaveBeenCalledWith(
      "acme/widgets",
      "goal",
      goal.id,
    )
  })

  it("selects the newest immutable revision without treating history as duplicate ownership", async () => {
    const previous = {
      tenantId: "acme/widgets",
      recordId: "goal:refresh-graph:old",
      kind: "goal",
      schemaVersion: 1,
      data: { ...goal, objective: null },
      createdAt: "2026-07-21T00:00:00.000Z",
    }
    const current = {
      tenantId: "acme/widgets",
      recordId: "goal:refresh-graph:new",
      kind: "goal",
      schemaVersion: 1,
      data: goal,
      createdAt: now,
    }
    const backend = {
      listAgencyDefinitions: vi.fn().mockResolvedValue([current, ...supportingDefinitions, previous]),
      getAgencyState: vi.fn().mockResolvedValue(null),
      putAgencyState: vi.fn(),
      appendAgencyOutput: vi.fn(),
      listAgencyOutputs: vi.fn().mockResolvedValue([]),
    }

    const catalog = await new AgencyModelRepository(backend, "acme/widgets").loadCatalog()

    expect(catalog.goals.get(goal.id)).toMatchObject({ definition: goal, revision: current.recordId })
  })

  it("rejects mismatched State instead of silently joining the wrong record", async () => {
    const backend = {
      listAgencyDefinitions: vi.fn().mockResolvedValue([
        ...supportingDefinitions,
        { tenantId: "acme/widgets", recordId: goal.id, kind: "goal", schemaVersion: 1, data: goal, createdAt: now },
      ]),
      getAgencyState: vi.fn().mockResolvedValue({
        tenantId: "acme/widgets",
        definitionId: "other",
        kind: "goal",
        schemaVersion: 1,
        data: { definitionId: "other", lifecycle: "active", progress: 0, blockers: [], updatedAt: now },
        updatedAt: now,
      }),
      putAgencyState: vi.fn(),
      appendAgencyOutput: vi.fn(),
      listAgencyOutputs: vi.fn().mockResolvedValue([]),
    }

    await expect(new AgencyModelRepository(backend, "acme/widgets").listManagedWork()).rejects.toThrow(
      "Agency State does not match Definition",
    )
  })
})
