import { describe, expect, it, vi } from "vitest"
import { dispatchAgencyLoopsWith } from "../../../src/scripts/dispatchAgencyLoops.js"
import type { StateBackend } from "../../../src/state-backend.js"

const tenantId = "acme/widgets"
const now = "2026-07-22T11:05:00.000Z"

describe("Agency Loop runtime dispatch", () => {
  it("reserves a due firing before dispatching its Workflow", async () => {
    const reserveAgencyDispatch = vi.fn().mockResolvedValue({ acquired: true, dispatchId: "dispatch-1" })
    const putAgencyState = vi.fn()
    const backend = {
      listAgencyDefinitions: vi.fn().mockResolvedValue([
        {
          tenantId,
          recordId: "refresh-knowledge",
          kind: "loop",
          schemaVersion: 1,
          data: {
            id: "refresh-knowledge",
            operationId: "knowledge",
            objective: { desiredState: "Knowledge stays current", requiredEvidence: [], scope: {} },
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
    expect(putAgencyState).toHaveBeenCalledTimes(2)
  })
})
