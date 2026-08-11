const WORKFLOW_RUN_LEASE_MS = 8 * 60 * 60 * 1_000

export interface WorkflowRunLeaseStore {
  acquireWorkflowRunLease(
    tenantId: string,
    workflowId: string,
    runId: string,
    ownerId: string,
    nowMs: number,
    leaseDurationMs: number,
  ): Promise<{ acquired: boolean; ownerId: string; expiresAtMs: number }>
  renewWorkflowRunLease(
    tenantId: string,
    workflowId: string,
    runId: string,
    ownerId: string,
    nowMs: number,
    leaseDurationMs: number,
  ): Promise<boolean>
  releaseWorkflowRunLease(tenantId: string, workflowId: string, runId: string, ownerId: string): Promise<boolean>
}

export class WorkflowRunLeaseLostError extends Error {
  constructor() {
    super("Workflow run ownership was lost; execution stopped to prevent duplicate work.")
    this.name = "WorkflowRunLeaseLostError"
  }
}

export async function acquireWorkflowRunLease(
  store: WorkflowRunLeaseStore,
  input: {
    tenantId: string
    workflowId: string
    runId: string
    ownerId: string
    nowMs: number
  },
): Promise<{ acquired: false; ownerId: string; expiresAtMs: number } | { acquired: true; lease: WorkflowRunLease }> {
  const result = await store.acquireWorkflowRunLease(
    input.tenantId,
    input.workflowId,
    input.runId,
    input.ownerId,
    input.nowMs,
    WORKFLOW_RUN_LEASE_MS,
  )
  if (!result.acquired) return result as { acquired: false; ownerId: string; expiresAtMs: number }
  return { acquired: true, lease: new WorkflowRunLease(store, input) }
}

class WorkflowRunLease {
  private released = false

  constructor(
    private readonly store: WorkflowRunLeaseStore,
    private readonly identity: {
      tenantId: string
      workflowId: string
      runId: string
      ownerId: string
    },
  ) {}

  async checkpoint(nowMs = Date.now()): Promise<void> {
    if (this.released) throw new WorkflowRunLeaseLostError()
    const renewed = await this.store.renewWorkflowRunLease(
      this.identity.tenantId,
      this.identity.workflowId,
      this.identity.runId,
      this.identity.ownerId,
      nowMs,
      WORKFLOW_RUN_LEASE_MS,
    )
    if (!renewed) throw new WorkflowRunLeaseLostError()
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    await this.store.releaseWorkflowRunLease(
      this.identity.tenantId,
      this.identity.workflowId,
      this.identity.runId,
      this.identity.ownerId,
    )
  }
}
