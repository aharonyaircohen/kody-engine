import { describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { stableJobKey } from "../../src/job.js"
import { dispatchNextTaskJob } from "../../src/scripts/dispatchNextTaskJob.js"
import { parseTaskJobSpecs, TASK_JOBS_MARKER, taskJobSpecToJob } from "../../src/scripts/planTaskJobs.js"
import { emptyState, upsertTaskJobs } from "../../src/state.js"

describe("task job plan parsing", () => {
  it("reads hidden task data from the issue body", () => {
    const specs = parseTaskJobSpecs(`Do the work.

<!-- ${TASK_JOBS_MARKER}
[
  { "executable": "plan-verify", "reason": "api slice" },
  { "executable": "probe-skill", "staff": "qa", "reason": "ui slice" }
]
-->
`)

    expect(specs).toEqual([
      { executable: "plan-verify", reason: "api slice" },
      { executable: "probe-skill", staff: "qa", reason: "ui slice" },
    ])
  })

  it("turns each entry into one instant job targeting the parent issue by default", () => {
    const job = taskJobSpecToJob({ executable: "plan-verify", reason: "api slice", staff: "qa" }, 42)

    expect(job).toMatchObject({
      executable: "plan-verify",
      cliArgs: { issue: 42 },
      target: 42,
      flavor: "instant",
      persona: "qa",
      why: "api slice",
    })
    expect(stableJobKey(job)).toBe("instant:plan-verify:42")
  })

  it("keeps explicit cliArgs when the task data needs a non-default target", () => {
    const job = taskJobSpecToJob({ executable: "review", cliArgs: { pr: 77 }, reason: "review slice" }, 42)

    expect(job.cliArgs).toEqual({ pr: 77 })
    expect(job.target).toBe(77)
    expect(stableJobKey(job)).toBe("instant:review:77")
  })

  it("rejects malformed task data instead of silently running the wrong thing", () => {
    expect(() => parseTaskJobSpecs(`<!-- ${TASK_JOBS_MARKER}\n{}\n-->`)).toThrow(/array/)
    expect(() => parseTaskJobSpecs(`<!-- ${TASK_JOBS_MARKER}\n[{ "reason": "missing executable" }]\n-->`)).toThrow(
      /executable/,
    )
  })

  it("dispatches the next pending job with a task-jobs return address", async () => {
    const job = taskJobSpecToJob({ executable: "plan-verify", reason: "api slice" }, 42)
    const id = stableJobKey(job)
    const taskState = upsertTaskJobs(
      emptyState(),
      [{ id, executable: "plan-verify", flavor: "instant", target: 42, reason: "api slice" }],
      "2026-06-08T08:00:00Z",
    )
    const ctx = {
      args: { issue: 42 },
      cwd: "/repo",
      config: {},
      data: { taskState, plannedTaskJobs: [job], plannedTaskJobIds: [id] },
      output: { exitCode: 0 },
    } as unknown as Context

    await dispatchNextTaskJob(ctx, { name: "task-jobs" } as Profile)

    expect(ctx.output.nextJob).toEqual(job)
    expect(ctx.output.afterNextJob).toEqual({ executable: "task-jobs", cliArgs: { issue: 42 } })
  })
})
