import { describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { failOnceTaskJob } from "../../src/scripts/failOnceTaskJob.js"
import { emptyState, reduce, upsertTaskJobs } from "../../src/state.js"

function makeCtx(taskState = emptyState()): Context {
  return {
    args: { issue: 42 },
    cwd: "/repo",
    config: {},
    data: {
      taskState,
      jobKey: "instant:task-job-fail-once:42",
    },
    output: { exitCode: 0 },
  } as unknown as Context
}

describe("failOnceTaskJob", () => {
  const profile = { name: "task-job-fail-once" } as Profile

  it("fails the first attempt for its planned job", async () => {
    const planned = upsertTaskJobs(
      emptyState(),
      [{ id: "instant:task-job-fail-once:42", executable: "task-job-fail-once", flavor: "instant", target: 42 }],
      "2026-06-08T08:00:00Z",
    )
    const ctx = makeCtx(planned)

    await failOnceTaskJob(ctx, profile, null)

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toMatch(/intentional first-attempt failure/)
  })

  it("succeeds after a failed run already exists", async () => {
    let state = upsertTaskJobs(
      emptyState(),
      [{ id: "instant:task-job-fail-once:42", executable: "task-job-fail-once", flavor: "instant", target: 42 }],
      "2026-06-08T08:00:00Z",
    )
    state = reduce(
      state,
      "task-job-fail-once",
      {
        type: "TASK_JOB_FAIL_ONCE_FAILED",
        payload: { reason: "intentional first-attempt failure" },
        timestamp: "2026-06-08T08:01:00Z",
      },
      "idle",
      null,
      { jobKey: "instant:task-job-fail-once:42", jobId: "gh-1", flavor: "instant", target: 42 },
    )
    const ctx = makeCtx(state)

    await failOnceTaskJob(ctx, profile, null)

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.output.reason).toMatch(/succeeded after prior failure/)
  })
})
