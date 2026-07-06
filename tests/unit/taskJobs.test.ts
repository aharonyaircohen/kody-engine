import { describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/implementations/types.js"
import { stableJobKey } from "../../src/job.js"
import { dispatchNextTaskJob } from "../../src/scripts/dispatchNextTaskJob.js"
import { parseTaskJobSpecs, TASK_JOBS_MARKER, taskJobSpecToJob } from "../../src/scripts/planTaskJobs.js"
import { emptyState, upsertTaskJobs } from "../../src/state.js"

describe("task job plan parsing", () => {
  it("reads hidden task data from the issue body", () => {
    const specs = parseTaskJobSpecs(`Do the work.

<!-- ${TASK_JOBS_MARKER}
[
  { "implementation": "plan-verify", "reason": "api slice" },
  { "implementation": "probe-skill", "agent": "qa", "reason": "ui slice" }
]
-->
`)

    expect(specs).toEqual([
      { implementation: "plan-verify", reason: "api slice" },
      { implementation: "probe-skill", agent: "qa", reason: "ui slice" },
    ])
  })

  it("turns each entry into one instant job targeting the parent issue by default", () => {
    const job = taskJobSpecToJob({ implementation: "plan-verify", reason: "api slice", agent: "qa" }, 42)

    expect(job).toMatchObject({
      capability: "plan-verify",
      implementation: "plan-verify",
      cliArgs: { issue: 42 },
      target: 42,
      flavor: "instant",
      agent: "qa",
      why: "api slice",
    })
    expect(stableJobKey(job)).toBe("instant:plan-verify:42")
  })

  it("turns a capability-planned entry into one scheduled child job", () => {
    const job = taskJobSpecToJob(
      {
        implementation: "probe-skill",
        capability: "daily-check",
        reason: "UI slice",
        agent: "qa",
        flavor: "scheduled",
        schedule: "1h",
      },
      42,
    )

    expect(job).toMatchObject({
      capability: "daily-check",
      implementation: "probe-skill",
      cliArgs: { issue: 42 },
      target: 42,
      flavor: "scheduled",
      agent: "qa",
      schedule: "1h",
      why: "UI slice",
    })
    expect(stableJobKey(job)).toBe("scheduled:daily-check:probe-skill")
  })

  it("keeps explicit cliArgs when the task data needs a non-default target", () => {
    const job = taskJobSpecToJob({ implementation: "review", cliArgs: { pr: 77 }, reason: "review slice" }, 42)

    expect(job.cliArgs).toEqual({ pr: 77 })
    expect(job.target).toBe(77)
    expect(stableJobKey(job)).toBe("instant:review:77")
  })

  it("rejects malformed task data instead of silently running the wrong thing", () => {
    expect(() => parseTaskJobSpecs(`<!-- ${TASK_JOBS_MARKER}\n{}\n-->`)).toThrow(/array/)
    expect(() => parseTaskJobSpecs(`<!-- ${TASK_JOBS_MARKER}\n[{ "reason": "missing implementation" }]\n-->`)).toThrow(
      /implementation/,
    )
  })

  it("dispatches the next pending job with a task-jobs return address", async () => {
    const job = taskJobSpecToJob({ implementation: "plan-verify", reason: "api slice" }, 42)
    const id = stableJobKey(job)
    const taskState = upsertTaskJobs(
      emptyState(),
      [{ id, implementation: "plan-verify", flavor: "instant", target: 42, reason: "api slice" }],
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
    expect(ctx.output.afterNextJob).toEqual({ action: "task-jobs", cliArgs: { issue: 42 } })
  })
})
