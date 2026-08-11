import { describe, expect, it, vi } from "vitest"
import { acquireWorkflowRunLease, WorkflowRunLeaseLostError } from "../../src/workflowRunLease.js"

function store(acquired = true) {
  return {
    acquireWorkflowRunLease: vi.fn().mockResolvedValue({
      acquired,
      ownerId: acquired ? "worker-a" : "worker-b",
      expiresAtMs: 99_000,
    }),
    renewWorkflowRunLease: vi.fn().mockResolvedValue(true),
    releaseWorkflowRunLease: vi.fn().mockResolvedValue(true),
  }
}

describe("workflow run lease", () => {
  it("returns busy when another worker owns the run", async () => {
    const backend = store(false)

    await expect(
      acquireWorkflowRunLease(backend, {
        tenantId: "acme/app",
        workflowId: "release",
        runId: "run-1",
        ownerId: "worker-a",
        nowMs: 1_000,
      }),
    ).resolves.toEqual({
      acquired: false,
      ownerId: "worker-b",
      expiresAtMs: 99_000,
    })
  })

  it("renews at checkpoints and releases after completion", async () => {
    const backend = store()
    const result = await acquireWorkflowRunLease(backend, {
      tenantId: "acme/app",
      workflowId: "release",
      runId: "run-1",
      ownerId: "worker-a",
      nowMs: 1_000,
    })
    if (!result.acquired) throw new Error("expected lease")

    await result.lease.checkpoint(2_000)
    await result.lease.release()

    expect(backend.renewWorkflowRunLease).toHaveBeenCalledOnce()
    expect(backend.releaseWorkflowRunLease).toHaveBeenCalledOnce()
  })

  it("stops execution when ownership was lost", async () => {
    const backend = store()
    backend.renewWorkflowRunLease.mockResolvedValue(false)
    const result = await acquireWorkflowRunLease(backend, {
      tenantId: "acme/app",
      workflowId: "release",
      runId: "run-1",
      ownerId: "worker-a",
      nowMs: 1_000,
    })
    if (!result.acquired) throw new Error("expected lease")

    await expect(result.lease.checkpoint(2_000)).rejects.toBeInstanceOf(WorkflowRunLeaseLostError)
  })
})
