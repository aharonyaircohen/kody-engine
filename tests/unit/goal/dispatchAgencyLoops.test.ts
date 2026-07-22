import { describe, expect, it, vi } from "vitest"
import type { Policy } from "@kody-ade/agency-domain"
import { dispatchAgencyLoopsWith } from "../../../src/scripts/dispatchAgencyLoops.js"
import type { StateBackend } from "../../../src/state-backend.js"

const tenantId = "acme/widgets"
const now = "2026-07-22T11:05:00.000Z"

function supportingDefinitions(policyOverrides: Partial<Policy> = {}) {
  const policy: Policy = {
    approval: "none",
    authority: { allow: ["refresh-knowledge-system"], deny: [] },
    budget: { maxRuns: 10, maxTokens: 10000, maxCostUsd: 10, maxDurationSeconds: 600 },
    maxConcurrentRuns: 1,
    riskyActions: [],
    ...policyOverrides,
  }
  return [
    {
      tenantId,
      recordId: "quality",
      kind: "intent",
      schemaVersion: 1,
      data: {
        id: "quality",
        direction: "Keep knowledge trustworthy",
        priorities: ["evidence"],
        policy,
        constraints: [],
      },
      createdAt: now,
    },
    {
      tenantId,
      recordId: "knowledge",
      kind: "operation",
      schemaVersion: 1,
      data: { id: "knowledge", name: "Knowledge", responsibility: "Refresh knowledge", intentIds: ["quality"] },
      createdAt: now,
    },
    {
      tenantId,
      recordId: "refresh-knowledge-system",
      kind: "workflow",
      schemaVersion: 1,
      data: {
        id: "refresh-knowledge-system",
        steps: [{ id: "build", capabilityRef: { kind: "capability", id: "build-graph" }, dependsOn: [] }],
      },
      createdAt: now,
    },
    {
      tenantId,
      recordId: "build-graph",
      kind: "capability",
      schemaVersion: 1,
      data: { id: "build-graph", action: "Build graph", input: "repository", output: "graph" },
      createdAt: now,
    },
  ]
}

describe("Agency Loop runtime dispatch", () => {
  it("reserves a due firing before dispatching its Workflow", async () => {
    const reserveAgencyDispatch = vi.fn().mockResolvedValue({ acquired: true, dispatchId: "dispatch-1" })
    const createAgencyModelRun = vi.fn()
    const putAgencyState = vi.fn()
    const backend = {
      listAgencyDefinitions: vi.fn().mockResolvedValue([
        ...supportingDefinitions(),
        {
          tenantId,
          recordId: "refresh-knowledge",
          kind: "loop",
          schemaVersion: 1,
          data: {
            id: "refresh-knowledge",
            operationId: "knowledge",
            objective: {
              desiredState: "Knowledge stays current",
              requiredEvidence: [],
              scope: { include: {}, exclude: {} },
            },
            trigger: { type: "schedule", every: "1h" },
            targetRef: { kind: "workflow", id: "refresh-knowledge-system" },
            reconciliationPolicy: { overlap: "skip", missed: "coalesce" },
          },
          createdAt: now,
        },
      ]),
      getAgencyState: vi.fn().mockResolvedValue({
        tenantId,
        definitionId: "refresh-knowledge",
        kind: "loop",
        schemaVersion: 1,
        data: {
          definitionId: "refresh-knowledge",
          lifecycle: "active",
          health: "healthy",
          failures: 0,
          lastFiredAt: "2026-07-22T10:00:00.000Z",
          updatedAt: "2026-07-22T10:00:00.000Z",
        },
        updatedAt: "2026-07-22T10:00:00.000Z",
      }),
      putAgencyState,
      appendAgencyOutput: vi.fn(),
      listAgencyOutputs: vi.fn().mockResolvedValue([]),
      reserveAgencyDispatch,
      recordSkippedAgencyDispatch: vi.fn(),
      finishAgencyDispatch: vi.fn(),
      createAgencyModelRun,
      finishAgencyModelRun: vi.fn(),
    } as unknown as StateBackend
    const run = vi.fn().mockResolvedValue({ exitCode: 0 })

    const results = await dispatchAgencyLoopsWith({ tenantId, backend, now: new Date(now), run })

    expect(results).toMatchObject([{ loopId: "refresh-knowledge", decision: "dispatched" }])
    expect(reserveAgencyDispatch).toHaveBeenCalledWith(
      tenantId,
      "refresh-knowledge:schedule:2026-07-22T11:00:00.000Z",
      "refresh-knowledge",
      expect.objectContaining({ kind: "fire" }),
      "2026-07-22T11:20:00.000Z",
      now,
    )
    expect(run).toHaveBeenCalledWith({ workflow: "refresh-knowledge-system", cliArgs: {}, flavor: "scheduled" })
    expect(reserveAgencyDispatch.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]!)
    expect(createAgencyModelRun.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]!)
    expect(createAgencyModelRun).toHaveBeenCalledWith(
      tenantId,
      "workflow",
      "refresh-knowledge-system",
      expect.objectContaining({
        status: "running",
        origin: { kind: "loop", id: "refresh-knowledge", revision: "refresh-knowledge" },
        target: {
          kind: "workflow",
          id: "refresh-knowledge-system",
          revision: "refresh-knowledge-system",
        },
        effectivePolicy: expect.objectContaining({ hash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      }),
      now,
    )
    expect(putAgencyState).toHaveBeenCalledTimes(2)
  })

  it("resolves a Goal target to its declared execution reference", async () => {
    const backend = {
      listAgencyDefinitions: vi.fn().mockResolvedValue([
        ...supportingDefinitions(),
        {
          tenantId,
          recordId: "refresh-goal",
          kind: "goal",
          schemaVersion: 1,
          data: {
            id: "refresh-goal",
            operationId: "knowledge",
            objective: {
              desiredState: "Knowledge stays current",
              requiredEvidence: [],
              scope: { include: {}, exclude: {} },
            },
            executionRef: { kind: "workflow", id: "refresh-knowledge-system" },
          },
          createdAt: now,
        },
        {
          tenantId,
          recordId: "refresh-loop",
          kind: "loop",
          schemaVersion: 1,
          data: {
            id: "refresh-loop",
            operationId: "knowledge",
            objective: {
              desiredState: "Knowledge stays current",
              requiredEvidence: [],
              scope: { include: {}, exclude: {} },
            },
            trigger: { type: "schedule", every: "1h" },
            targetRef: { kind: "goal", id: "refresh-goal" },
            reconciliationPolicy: { overlap: "skip", missed: "coalesce" },
          },
          createdAt: now,
        },
      ]),
      getAgencyState: vi.fn(async (_tenant: string, id: string) =>
        id === "refresh-loop"
          ? {
              tenantId,
              definitionId: id,
              kind: "loop",
              schemaVersion: 1,
              data: {
                definitionId: id,
                lifecycle: "active",
                health: "healthy",
                failures: 0,
                lastFiredAt: "2026-07-22T10:00:00.000Z",
                updatedAt: "2026-07-22T10:00:00.000Z",
              },
              updatedAt: "2026-07-22T10:00:00.000Z",
            }
          : null,
      ),
      putAgencyState: vi.fn(),
      appendAgencyOutput: vi.fn(),
      listAgencyOutputs: vi.fn().mockResolvedValue([]),
      reserveAgencyDispatch: vi.fn().mockResolvedValue({ acquired: true, dispatchId: "dispatch-2" }),
      recordSkippedAgencyDispatch: vi.fn(),
      finishAgencyDispatch: vi.fn(),
      createAgencyModelRun: vi.fn(),
      finishAgencyModelRun: vi.fn(),
    } as unknown as StateBackend
    const run = vi.fn().mockResolvedValue({ exitCode: 0 })

    await dispatchAgencyLoopsWith({ tenantId, backend, now: new Date(now), run })

    expect(run).toHaveBeenCalledWith({ workflow: "refresh-knowledge-system", cliArgs: {}, flavor: "scheduled" })
  })

  it("records a policy rejection without starting a Run", async () => {
    const definitions = supportingDefinitions({ authority: { allow: ["*"], deny: ["refresh-knowledge-system"] } })
    const recordSkippedAgencyDispatch = vi.fn()
    const run = vi.fn()
    const backend = {
      listAgencyDefinitions: vi.fn().mockResolvedValue([
        ...definitions,
        {
          tenantId,
          recordId: "refresh-loop",
          kind: "loop",
          schemaVersion: 1,
          data: {
            id: "refresh-loop",
            operationId: "knowledge",
            objective: {
              desiredState: "Knowledge stays current",
              requiredEvidence: [],
              scope: { include: {}, exclude: {} },
            },
            trigger: { type: "schedule", every: "1h" },
            targetRef: { kind: "workflow", id: "refresh-knowledge-system" },
            reconciliationPolicy: { overlap: "skip", missed: "coalesce" },
          },
          createdAt: now,
        },
      ]),
      getAgencyState: vi.fn().mockResolvedValue({
        tenantId,
        definitionId: "refresh-loop",
        kind: "loop",
        schemaVersion: 1,
        data: {
          definitionId: "refresh-loop",
          lifecycle: "active",
          health: "healthy",
          failures: 0,
          lastFiredAt: "2026-07-22T10:00:00.000Z",
          updatedAt: "2026-07-22T10:00:00.000Z",
        },
        updatedAt: "2026-07-22T10:00:00.000Z",
      }),
      putAgencyState: vi.fn(),
      appendAgencyOutput: vi.fn(),
      listAgencyOutputs: vi.fn().mockResolvedValue([]),
      reserveAgencyDispatch: vi.fn(),
      recordSkippedAgencyDispatch,
      finishAgencyDispatch: vi.fn(),
      createAgencyModelRun: vi.fn(),
      finishAgencyModelRun: vi.fn(),
    } as unknown as StateBackend

    const results = await dispatchAgencyLoopsWith({ tenantId, backend, now: new Date(now), run })

    expect(results).toMatchObject([{ decision: "skipped", reason: expect.stringMatching(/authority denies/) }])
    expect(recordSkippedAgencyDispatch).toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})
