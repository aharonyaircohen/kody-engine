import { describe, expect, it, vi } from "vitest"
import { AgencyModelRepository } from "../../../src/goal/agencyModelRepository.js"

const goal = {
  id: "refresh-graph",
  operationId: "knowledge",
  objective: { desiredState: "Graph is current", requiredEvidence: ["published"], scope: {} },
  executionRef: { kind: "workflow", id: "refresh-graph" },
}
const now = "2026-07-22T00:00:00.000Z"

describe("AgencyModelRepository", () => {
  it("loads and validates clean Definitions separately from mutable State", async () => {
    const backend = {
      listAgencyDefinitions: vi.fn().mockResolvedValue([
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
    }

    const records = await new AgencyModelRepository(backend, "acme/widgets").listManagedWork()

    expect(records).toHaveLength(1)
    expect(records[0]?.definition).toEqual(goal)
    expect(records[0]?.definition).not.toHaveProperty("version")
    expect(records[0]?.state).toMatchObject({ definitionId: goal.id, lifecycle: "active" })
  })

  it("rejects mismatched State instead of silently joining the wrong record", async () => {
    const backend = {
      listAgencyDefinitions: vi.fn().mockResolvedValue([
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
    }

    await expect(new AgencyModelRepository(backend, "acme/widgets").listManagedWork()).rejects.toThrow(
      "Agency State does not match Definition",
    )
  })
})
