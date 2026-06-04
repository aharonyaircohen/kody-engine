import { beforeEach, describe, expect, it, vi } from "vitest"

// Hoist-safe mock of the executor so runJob is tested in isolation (no real
// executable spins up). Mirrors tests/unit/dispatchJobFileTicks.routing.test.ts.
const { runExecutableChain } = vi.hoisted(() => ({ runExecutableChain: vi.fn() }))
vi.mock("../../src/executor.js", () => ({ runExecutableChain }))

import {
  DEFAULT_INSTANT_PERSONA,
  InvalidJobError,
  mintInstantJob,
  mintScheduledJob,
  runJob,
  validateJob,
} from "../../src/job.js"

describe("runJob (Phase 1 seam)", () => {
  beforeEach(() => {
    runExecutableChain.mockReset()
    runExecutableChain.mockResolvedValue({ exitCode: 0 })
  })

  it("lowers an instant job onto runExecutableChain with its executable + cliArgs", async () => {
    await runJob({ executable: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" }, { cwd: "/x" })
    expect(runExecutableChain).toHaveBeenCalledTimes(1)
    const [profile, input] = runExecutableChain.mock.calls[0]!
    expect(profile).toBe("run")
    expect(input.cliArgs).toEqual({ issue: 42 })
    expect(input.cwd).toBe("/x")
  })

  it("seeds inline why into preloadedData.jobWhy", async () => {
    await runJob({ executable: "fix", why: "fix the flaky test", cliArgs: {}, flavor: "instant" }, { cwd: "/x" })
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBe("fix the flaky test")
    expect(input.preloadedData?.jobIntent).toBeUndefined()
  })

  it("does not seed jobWhy for an empty why string", async () => {
    await runJob({ executable: "run", why: "", cliArgs: {}, flavor: "instant" }, { cwd: "/x" })
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData).toBeUndefined()
  })

  it("carries the DispatchResult's why through mintInstantJob into jobWhy", async () => {
    await runJob(mintInstantJob({ executable: "run", cliArgs: { issue: 5 }, target: 5, why: "also add tests" }), {
      cwd: "/x",
    })
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBe("also add tests")
  })

  it("seeds persona into preloadedData.jobPersona", async () => {
    await runJob(
      { duty: "stale-prs", persona: "kody", schedule: "*/5 * * * *", cliArgs: {}, flavor: "scheduled" },
      { cwd: "/x" },
    )
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobPersona).toBe("kody")
  })

  it("falls back to the duty slug as the profile when no executable", async () => {
    await runJob({ duty: "watch-stale-prs", schedule: "*/5 * * * *", cliArgs: {}, flavor: "scheduled" }, { cwd: "/x" })
    expect(runExecutableChain.mock.calls[0]![0]).toBe("watch-stale-prs")
  })

  it("does not seed preloadedData when there is no why/persona", async () => {
    await runJob({ executable: "run", cliArgs: {}, flavor: "instant" }, { cwd: "/x" })
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData).toBeUndefined()
  })

  it("rejects a job with neither executable nor duty", () => {
    expect(() => validateJob({ cliArgs: {}, flavor: "instant" })).toThrow(InvalidJobError)
  })

  it("rejects an unknown flavor", () => {
    expect(() => validateJob({ executable: "run", cliArgs: {}, flavor: "bogus" })).toThrow(InvalidJobError)
  })

  it("defaults cliArgs to an empty object when omitted", () => {
    const j = validateJob({ executable: "run", flavor: "instant" })
    expect(j.cliArgs).toEqual({})
  })
})

describe("mintInstantJob (Phase 2)", () => {
  const dispatch = { executable: "fix", cliArgs: { pr: 7 }, target: 7 }

  it("maps a DispatchResult to an instant job", () => {
    const job = mintInstantJob(dispatch, { why: "fix the typo" })
    expect(job).toMatchObject({
      executable: "fix",
      target: 7,
      cliArgs: { pr: 7 },
      why: "fix the typo",
      flavor: "instant",
    })
  })

  it("defaults persona to the standard staff member", () => {
    expect(mintInstantJob(dispatch).persona).toBe(DEFAULT_INSTANT_PERSONA)
  })

  it("lets the caller override the persona", () => {
    expect(mintInstantJob(dispatch, { persona: "reviewer" }).persona).toBe("reviewer")
  })

  it("produces a job that runJob can run", async () => {
    runExecutableChain.mockResolvedValue({ exitCode: 0 })
    await runJob(mintInstantJob(dispatch, { why: "x" }), { cwd: "/x" })
    expect(runExecutableChain.mock.calls.at(-1)![0]).toBe("fix")
  })
})

describe("mintScheduledJob (Phase 2)", () => {
  it("maps a due duty slug to a scheduled job", () => {
    const job = mintScheduledJob({
      duty: "stale-prs",
      executable: "job-tick",
      schedule: "*/5 * * * *",
      persona: "kody",
      cliArgs: { job: "stale-prs" },
    })
    expect(job).toMatchObject({
      duty: "stale-prs",
      executable: "job-tick",
      schedule: "*/5 * * * *",
      persona: "kody",
      cliArgs: { job: "stale-prs" },
      flavor: "scheduled",
    })
  })

  it("defaults cliArgs to empty", () => {
    expect(mintScheduledJob({ duty: "d", executable: "job-tick" }).cliArgs).toEqual({})
  })
})
