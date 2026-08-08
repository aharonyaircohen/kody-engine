import { getFunctionName } from "convex/server"
import { describe, expect, it, vi } from "vitest"
import { createStateBackendFromEnv } from "../../src/state-backend.js"

describe("Loop runtime state backend", () => {
  it("uses one atomic reservation for each schedule slot", async () => {
    const mutation = vi.fn().mockResolvedValue({ acquired: true, dispatchId: "dispatch-1" })
    const backend = createStateBackendFromEnv({}, { query: vi.fn(), mutation })

    await expect(
      backend.reserveLoopDispatch("acme/widgets", {
        idempotencyKey: "loop-1:2026-07-22T12:00:00.000Z",
        loopId: "loop-1",
        decision: {
          kind: "fire",
          reason: "scheduled trigger is due",
          scheduledAt: "2026-07-22T12:00:00.000Z",
        },
        leaseUntil: "2026-07-22T12:15:00.000Z",
        reservationId: "reservation-1",
        correlationId: "correlation-1",
        policyHash: "loop:loop-1",
        effectivePolicy: { source: "repository" },
        definitionRefs: [{ kind: "loop", id: "loop-1" }],
        maxConcurrentRuns: 1,
        requiresApproval: false,
        approvalScopeKind: "loop",
        approvalScopeId: "loop-1",
        approvalAction: "workflow:refresh-knowledge",
        now: "2026-07-22T12:00:00.000Z",
      }),
    ).resolves.toMatchObject({ acquired: true })

    expect(getFunctionName(mutation.mock.calls[0]?.[0])).toBe("agencyModel:reserveDispatch")
    expect(mutation.mock.calls[0]?.[1]).toMatchObject({
      tenantId: "acme/widgets",
      loopId: "loop-1",
      idempotencyKey: "loop-1:2026-07-22T12:00:00.000Z",
    })
  })

  it("persists one parent Run through explicit lifecycle operations", async () => {
    const mutation = vi.fn()
    const backend = createStateBackendFromEnv({}, { query: vi.fn(), mutation })
    const running = {
      id: "loop-run-1",
      status: "running",
      target: { kind: "workflow", id: "refresh-knowledge" },
      agent: "kody",
      startedAt: "2026-07-22T12:00:00.000Z",
    }

    await backend.createAgencyRun("acme/widgets", "loop", "loop-1", running, "2026-07-22T12:00:00.000Z")
    await backend.finishAgencyRun(
      "acme/widgets",
      { ...running, status: "succeeded", finishedAt: "2026-07-22T12:01:00.000Z" },
      "2026-07-22T12:01:00.000Z",
    )

    expect(mutation.mock.calls.map(([fn]) => getFunctionName(fn))).toEqual([
      "agencyModel:createRunRecord",
      "agencyModel:finishRunRecord",
    ])
    expect(mutation.mock.calls[0]?.[1]).toMatchObject({
      tenantId: "acme/widgets",
      subjectType: "loop",
      subjectId: "loop-1",
      run: running,
    })
  })

  it("renews only the reservation held by the running Loop", async () => {
    const mutation = vi.fn()
    const backend = createStateBackendFromEnv({}, { query: vi.fn(), mutation })

    await backend.renewLoopDispatch(
      "acme/widgets",
      "loop-1:2026-07-22T12:00:00.000Z",
      "reservation-1",
      "2026-07-22T12:11:00.000Z",
      "2026-07-22T12:01:00.000Z",
    )

    expect(getFunctionName(mutation.mock.calls[0]?.[0])).toBe("agencyModel:renewDispatch")
    expect(mutation.mock.calls[0]?.[1]).toEqual({
      tenantId: "acme/widgets",
      idempotencyKey: "loop-1:2026-07-22T12:00:00.000Z",
      reservationId: "reservation-1",
      leaseUntil: "2026-07-22T12:11:00.000Z",
      now: "2026-07-22T12:01:00.000Z",
    })
  })
})
