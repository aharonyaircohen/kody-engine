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

function loopBackend(input: {
  policyOverrides?: Partial<Policy>
  failure?: { maxAttempts: number; backoffSeconds: number; timeoutSeconds: number }
  finishAgencyDispatch: ReturnType<typeof vi.fn>
  createAgencyModelRun?: ReturnType<typeof vi.fn>
  finishAgencyModelRun?: ReturnType<typeof vi.fn>
}) {
  const loopId = "bounded-loop"
  return {
    listAgencyDefinitions: vi.fn().mockResolvedValue([
      ...supportingDefinitions(input.policyOverrides),
      {
        tenantId,
        recordId: loopId,
        kind: "loop",
        schemaVersion: 1,
        data: {
          id: loopId,
          operationId: "knowledge",
          objective: {
            desiredState: "Knowledge stays current",
            requiredEvidence: [],
            scope: { include: {}, exclude: {} },
          },
          trigger: { type: "schedule", every: "1h" },
          targetRef: { kind: "workflow", id: "refresh-knowledge-system" },
          reconciliationPolicy: {
            overlap: "skip",
            missed: "coalesce",
            failure: input.failure ?? { maxAttempts: 3, backoffSeconds: 0, timeoutSeconds: 60 },
          },
        },
        createdAt: now,
      },
    ]),
    getAgencyState: vi.fn().mockResolvedValue({
      tenantId,
      definitionId: loopId,
      kind: "loop",
      schemaVersion: 1,
      data: {
        definitionId: loopId,
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
    reserveAgencyDispatch: vi.fn().mockResolvedValue({ acquired: true, dispatchId: "dispatch-bounded" }),
    recordSkippedAgencyDispatch: vi.fn(),
    finishAgencyDispatch: input.finishAgencyDispatch,
    createAgencyModelRun: input.createAgencyModelRun ?? vi.fn(),
    finishAgencyModelRun: input.finishAgencyModelRun ?? vi.fn(),
  } as unknown as StateBackend
}

describe("Agency Loop runtime dispatch", () => {
  it("reserves a due firing before dispatching its Workflow", async () => {
    const reserveAgencyDispatch = vi.fn().mockResolvedValue({ acquired: true, dispatchId: "dispatch-1" })
    const createAgencyModelRun = vi.fn()
    const finishAgencyModelRun = vi.fn()
    const finishAgencyDispatch = vi.fn()
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
      reconciliationPolicy: { overlap: "skip", missed: "coalesce", failure: { maxAttempts: 3, backoffSeconds: 0, timeoutSeconds: 60 } },
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
      finishAgencyDispatch,
      createAgencyModelRun,
      finishAgencyModelRun,
    } as unknown as StateBackend
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, reason: "temporary failure", usage: { tokens: 10, costUsd: 0.01 } })
      .mockResolvedValueOnce({ exitCode: 0, reason: "recovered", usage: { tokens: 20, costUsd: 0.02 } })

    const results = await dispatchAgencyLoopsWith({ tenantId, backend, now: new Date(now), run })

    expect(results).toMatchObject([{ loopId: "refresh-knowledge", decision: "dispatched" }])
    expect(reserveAgencyDispatch).toHaveBeenCalledWith(
      tenantId,
      expect.objectContaining({
        idempotencyKey: "refresh-knowledge:schedule:2026-07-22T11:00:00.000Z",
        loopId: "refresh-knowledge",
        decision: expect.objectContaining({ kind: "fire" }),
        leaseUntil: "2026-07-22T11:08:00.000Z",
        policyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        maxConcurrentRuns: 1,
        requiresApproval: false,
        approvalScopeKind: "loop",
        approvalScopeId: "refresh-knowledge",
        approvalAction: "workflow:refresh-knowledge-system",
        now,
      }),
    )
    expect(run).toHaveBeenCalledWith(
      { workflow: "refresh-knowledge-system", cliArgs: {}, flavor: "scheduled" },
      expect.any(AbortController),
    )
    expect(run).toHaveBeenCalledTimes(2)
    expect(createAgencyModelRun).toHaveBeenCalledTimes(2)
    expect(finishAgencyModelRun).toHaveBeenCalledTimes(2)
    expect(finishAgencyModelRun).toHaveBeenLastCalledWith(
      tenantId,
      expect.objectContaining({
        status: "succeeded",
        usage: expect.objectContaining({ tokens: 20, costUsd: 0.02 }),
      }),
      expect.any(String),
    )
    expect(finishAgencyDispatch).toHaveBeenCalledWith(
      tenantId,
      expect.any(String),
      expect.any(String),
      "dispatched",
      expect.any(String),
      expect.any(String),
    )
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
      expect.any(String),
    )
    expect(putAgencyState).toHaveBeenCalledTimes(2)
  })

  it("resolves a Goal target to its declared execution reference", async () => {
    const outputs: Array<{
      tenantId: string
      recordId: string
      schemaVersion: number
      runId: string
      data: unknown
    }> = []
    const appendAgencyOutput = vi.fn(
      async (storedTenantId: string, recordId: string, schemaVersion: number, data: unknown) => {
        outputs.push({
          tenantId: storedTenantId,
          recordId,
          schemaVersion,
          runId: (data as { runId: string }).runId,
          data,
        })
      },
    )
    const putAgencyState = vi.fn()
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
              requiredEvidence: ["graph-published"],
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
      reconciliationPolicy: { overlap: "skip", missed: "coalesce", failure: { maxAttempts: 3, backoffSeconds: 0, timeoutSeconds: 60 } },
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
      putAgencyState,
      appendAgencyOutput,
      listAgencyOutputs: vi.fn(async () => outputs),
      reserveAgencyDispatch: vi.fn().mockResolvedValue({ acquired: true, dispatchId: "dispatch-2" }),
      recordSkippedAgencyDispatch: vi.fn(),
      finishAgencyDispatch: vi.fn(),
      createAgencyModelRun: vi.fn(),
      finishAgencyModelRun: vi.fn(),
    } as unknown as StateBackend
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      capabilityResults: [
        {
          version: 1,
          status: "pass",
          summary: "Knowledge graph published",
          evidence: { "graph-published": true },
          facts: { nodeCount: 42 },
          artifacts: [{ label: "knowledge-graph", path: "graph.json" }],
          missingEvidence: [],
          blockers: [],
        },
      ],
    })

    await dispatchAgencyLoopsWith({ tenantId, backend, now: new Date(now), run })

    expect(run).toHaveBeenCalledWith(
      { workflow: "refresh-knowledge-system", cliArgs: {}, flavor: "scheduled" },
      expect.any(AbortController),
    )
    expect(appendAgencyOutput).toHaveBeenCalledTimes(3)
    expect(appendAgencyOutput).toHaveBeenCalledWith(
      tenantId,
      expect.stringMatching(/^output-/),
      1,
      expect.objectContaining({
        kind: "evidence",
        key: "graph-published",
        value: true,
        producer: { kind: "workflow", id: "refresh-knowledge-system" },
        contract: "capability-result/v1",
      }),
    )
    expect(putAgencyState).toHaveBeenCalledWith(
      tenantId,
      "refresh-goal",
      "goal",
      1,
      expect.objectContaining({ definitionId: "refresh-goal", progress: 1 }),
      expect.any(String),
    )
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
      reconciliationPolicy: { overlap: "skip", missed: "coalesce", failure: { maxAttempts: 3, backoffSeconds: 0, timeoutSeconds: 60 } },
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

  it("keeps an approved-policy firing waiting until the backend grants it", async () => {
    const definitions = supportingDefinitions({ approval: "all-actions" })
    const reserveAgencyDispatch = vi.fn().mockResolvedValue({
      acquired: false,
      reason: "approval-required",
    })
    const run = vi.fn()
    const backend = {
      listAgencyDefinitions: vi.fn().mockResolvedValue([
        ...definitions,
        {
          tenantId,
          recordId: "approval-loop",
          kind: "loop",
          schemaVersion: 1,
          data: {
            id: "approval-loop",
            operationId: "knowledge",
            objective: {
              desiredState: "Knowledge stays current",
              requiredEvidence: [],
              scope: { include: {}, exclude: {} },
            },
            trigger: { type: "schedule", every: "1h" },
            targetRef: { kind: "workflow", id: "refresh-knowledge-system" },
      reconciliationPolicy: { overlap: "skip", missed: "coalesce", failure: { maxAttempts: 3, backoffSeconds: 0, timeoutSeconds: 60 } },
          },
          createdAt: now,
        },
      ]),
      getAgencyState: vi.fn().mockResolvedValue({
        tenantId,
        definitionId: "approval-loop",
        kind: "loop",
        schemaVersion: 1,
        data: {
          definitionId: "approval-loop",
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
      reserveAgencyDispatch,
      recordSkippedAgencyDispatch: vi.fn(),
      finishAgencyDispatch: vi.fn(),
      createAgencyModelRun: vi.fn(),
      finishAgencyModelRun: vi.fn(),
    } as unknown as StateBackend

    const results = await dispatchAgencyLoopsWith({ tenantId, backend, now: new Date(now), run })

    expect(results).toMatchObject([{ decision: "skipped", reason: "dispatch is waiting for approval" }])
    expect(reserveAgencyDispatch).toHaveBeenCalledWith(
      tenantId,
      expect.objectContaining({ requiresApproval: true, approvalScopeId: "approval-loop" }),
    )
    expect(run).not.toHaveBeenCalled()
  })

  it("dead-letters an exhausted firing and never exceeds the policy run budget", async () => {
    const finishAgencyDispatch = vi.fn()
    const createAgencyModelRun = vi.fn()
    const finishAgencyModelRun = vi.fn()
    const backend = loopBackend({
      policyOverrides: {
        budget: { maxRuns: 2, maxTokens: 100, maxCostUsd: 1, maxDurationSeconds: 120 },
      },
      failure: { maxAttempts: 5, backoffSeconds: 0, timeoutSeconds: 60 },
      finishAgencyDispatch,
      createAgencyModelRun,
      finishAgencyModelRun,
    })
    const run = vi.fn().mockResolvedValue({
      exitCode: 1,
      reason: "still failing",
      usage: { tokens: 10, costUsd: 0.1 },
    })

    const results = await dispatchAgencyLoopsWith({ tenantId, backend, now: new Date(now), run })

    expect(run).toHaveBeenCalledTimes(2)
    expect(createAgencyModelRun).toHaveBeenCalledTimes(2)
    expect(finishAgencyModelRun).toHaveBeenCalledTimes(2)
    expect(finishAgencyDispatch).toHaveBeenCalledWith(
      tenantId,
      expect.any(String),
      expect.any(String),
      "dead-letter",
      expect.any(String),
      expect.any(String),
    )
    expect(results).toMatchObject([
      { loopId: "bounded-loop", decision: "failed", reason: expect.stringMatching(/dead-lettered after 2 attempts/) },
    ])
  })

  it("aborts and dead-letters a target that exceeds its hard timeout", async () => {
    vi.useFakeTimers()
    try {
      const finishAgencyDispatch = vi.fn()
      const backend = loopBackend({
        policyOverrides: {
          budget: { maxRuns: 1, maxTokens: 100, maxCostUsd: 1, maxDurationSeconds: 10 },
        },
        failure: { maxAttempts: 1, backoffSeconds: 0, timeoutSeconds: 1 },
        finishAgencyDispatch,
      })
      let controller: AbortController | undefined
      const run = vi.fn((_job, current: AbortController) => {
        controller = current
        return new Promise<never>(() => undefined)
      })

      const pending = dispatchAgencyLoopsWith({ tenantId, backend, now: new Date(now), run })
      await vi.advanceTimersByTimeAsync(1_000)
      const results = await pending

      expect(controller?.signal.aborted).toBe(true)
      expect(finishAgencyDispatch).toHaveBeenCalledWith(
        tenantId,
        expect.any(String),
        expect.any(String),
        "dead-letter",
        expect.any(String),
        expect.any(String),
      )
      expect(results).toMatchObject([{ decision: "failed", reason: expect.stringMatching(/timed out after 1s/) }])
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects a nominally successful target when measured usage exceeds policy", async () => {
    const finishAgencyDispatch = vi.fn()
    const backend = loopBackend({
      policyOverrides: {
        budget: { maxRuns: 1, maxTokens: 5, maxCostUsd: 1, maxDurationSeconds: 60 },
      },
      failure: { maxAttempts: 1, backoffSeconds: 0, timeoutSeconds: 60 },
      finishAgencyDispatch,
    })
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      reason: "work completed",
      usage: { tokens: 6, costUsd: 0.1 },
    })

    const results = await dispatchAgencyLoopsWith({ tenantId, backend, now: new Date(now), run })

    expect(finishAgencyDispatch).toHaveBeenCalledWith(
      tenantId,
      expect.any(String),
      expect.any(String),
      "dead-letter",
      expect.any(String),
      expect.any(String),
    )
    expect(results).toMatchObject([
      { decision: "failed", reason: expect.stringMatching(/token budget exhausted/) },
    ])
  })
})
