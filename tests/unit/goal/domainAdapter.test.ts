import { describe, expect, it } from "vitest"
import { migrateLegacyManagedWork } from "../../../src/goal/domainAdapter.js"
import { parseGoalState } from "../../../src/goal/state.js"

describe("managed work domain adapter", () => {
  it("moves Goal routes into a Workflow Definition", () => {
    const legacy = parseGoalState("todos/refresh.json", {
      state: "active",
      type: "improve",
      destination: { outcome: "Graph is current", evidence: ["published"] },
      route: [{ stage: "build", evidence: "published", capability: "build-knowledge-graph" }],
      capabilities: ["build-knowledge-graph"],
      facts: {},
      blockers: [],
      operationId: "knowledge",
    })

    const migrated = migrateLegacyManagedWork("refresh", legacy)

    expect(migrated.kind).toBe("goal")
    if (migrated.kind !== "goal") throw new Error("Expected Goal migration")
    expect(migrated.definition).toMatchObject({
      id: "refresh",
      operationId: "knowledge",
      executionRef: { kind: "workflow", id: "refresh-workflow" },
    })
    expect(migrated.definition).not.toHaveProperty("version")
    expect(migrated.workflow?.steps).toHaveLength(1)
  })

  it("moves schedule and target into a Loop Definition", () => {
    const legacy = parseGoalState("todos/knowledge-refresh.json", {
      state: "active",
      managedModel: "agentLoop",
      type: "agentLoop",
      destination: { outcome: "Graph stays current", evidence: ["published"] },
      schedule: "1h",
      loopTarget: { type: "workflow", id: "refresh-knowledge" },
      route: [],
      capabilities: [],
      facts: {},
      blockers: [],
      operationId: "knowledge",
    })

    const migrated = migrateLegacyManagedWork("knowledge-refresh", legacy)

    expect(migrated.kind).toBe("loop")
    expect(migrated.definition).toMatchObject({
      trigger: { type: "schedule", every: "1h" },
      targetRef: { kind: "workflow", id: "refresh-knowledge" },
    })
  })
})
