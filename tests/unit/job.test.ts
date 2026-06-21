import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Hoist-safe mock of the executor so runJob is tested in isolation (no real
// executable spins up). Mirrors tests/unit/dispatchDutyFileTicks.routing.test.ts.
const { runExecutableChain } = vi.hoisted(() => ({ runExecutableChain: vi.fn() }))
vi.mock("../../src/executor.js", () => ({ runExecutableChain }))

import {
  DEFAULT_INSTANT_PERSONA,
  InvalidJobError,
  mintInstantJob,
  mintScheduledJob,
  newJobId,
  runJob,
  validateJob,
} from "../../src/job.js"

describe("runJob (Phase 1 seam)", () => {
  beforeEach(() => {
    runExecutableChain.mockReset()
    runExecutableChain.mockResolvedValue({ exitCode: 0 })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("lowers an instant job onto runExecutableChain with its executable + cliArgs", async () => {
    await runJob(
      { duty: "run", executable: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    expect(runExecutableChain).toHaveBeenCalledTimes(1)
    const [profile, input] = runExecutableChain.mock.calls[0]!
    expect(profile).toBe("run")
    expect(input.cliArgs).toEqual({ issue: 42 })
    expect(input.cwd).toBe("/x")
    expect(input.preloadedData?.jobDuty).toBe("run")
  })

  it("lowers an action-only instant job through the duty action registry", async () => {
    await runJob({ action: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" }, { cwd: "/x" })
    const [profile, input] = runExecutableChain.mock.calls[0]!
    expect(profile).toBe("run")
    expect(input.cliArgs).toEqual({ issue: 42 })
    expect(input.preloadedData?.jobAction).toBe("run")
    expect(input.preloadedData?.jobDuty).toBe("run")
    expect(input.preloadedData?.jobExecutable).toBe("run")
  })

  it("resolves a duty-only job to the duty-selected executable", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-duty-job-"))
    const dutyDir = path.join(cwd, ".kody", "duties", "ci-health")
    fs.mkdirSync(dutyDir, { recursive: true })
    fs.writeFileSync(
      path.join(dutyDir, "profile.json"),
      JSON.stringify({ name: "ci-health", action: "ci-health", executable: "ci-check", staff: "kody" }),
    )
    fs.writeFileSync(path.join(dutyDir, "duty.md"), "# CI Health\n")

    await runJob(
      {
        duty: "ci-health",
        cliArgs: { pr: 456, goal: "release-aguy", evidence: "mainDeployPrGreen" },
        flavor: "instant",
      },
      { cwd },
    )

    const [profile, input] = runExecutableChain.mock.calls[0]!
    expect(profile).toBe("ci-check")
    expect(input.cliArgs).toEqual({ pr: 456, goal: "release-aguy", evidence: "mainDeployPrGreen" })
    expect(input.preloadedData?.jobDuty).toBe("ci-health")
    expect(input.preloadedData?.jobExecutable).toBe("ci-check")
  })
  it("preserves duty identity without injecting duty args when executable is explicit", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-goal-handoff-"))
    const dutyDir = path.join(cwd, ".kody", "duties", "company-graph")
    fs.mkdirSync(dutyDir, { recursive: true })
    fs.writeFileSync(path.join(dutyDir, "profile.json"), JSON.stringify({ name: "company-graph" }))
    fs.writeFileSync(path.join(dutyDir, "duty.md"), "# Company Graph\n")
    await runJob(
      {
        duty: "company-graph",
        executable: "company-graph",
        cliArgs: { goal: "hourly-monitor-goal-smoke" },
        flavor: "instant",
      },
      { cwd },
    )
    const [profile, input] = runExecutableChain.mock.calls[0]!
    expect(profile).toBe("company-graph")
    expect(input.cliArgs).toEqual({ goal: "hourly-monitor-goal-smoke" })
    expect(input.preloadedData?.jobDuty).toBe("company-graph")
    expect(input.preloadedData?.jobExecutable).toBe("company-graph")
  })

  it("seeds inline why into preloadedData.jobWhy", async () => {
    await runJob(
      { duty: "fix", executable: "fix", why: "fix the flaky test", cliArgs: {}, flavor: "instant" },
      { cwd: "/x" },
    )
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBe("fix the flaky test")
    expect(input.preloadedData?.jobIntent).toContain("Apply review feedback")
  })

  it("does not seed jobWhy for an empty why string", async () => {
    await runJob({ duty: "run", executable: "run", why: "", cliArgs: {}, flavor: "instant" }, { cwd: "/x" })
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBeUndefined()
  })

  it("always seeds a jobId + flavor so the run can be recorded in the task ledger", async () => {
    await runJob(
      { duty: "run", executable: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(typeof input.preloadedData?.jobId).toBe("string")
    expect(input.preloadedData?.jobKey).toBe("instant:run:42")
    expect(input.preloadedData?.jobFlavor).toBe("instant")
    expect(input.preloadedData?.jobExecutable).toBe("run")
    expect(input.preloadedData?.jobTarget).toBe(42)
  })

  it("keeps the same stable job key for retries of the same target + executable", async () => {
    await runJob(
      { duty: "run", executable: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    await runJob(
      { duty: "run", executable: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )

    const first = runExecutableChain.mock.calls[0]![1].preloadedData
    const second = runExecutableChain.mock.calls[1]![1].preloadedData
    expect(first?.jobKey).toBe("instant:run:42")
    expect(second?.jobKey).toBe("instant:run:42")
    expect(first?.jobId).not.toBe(second?.jobId)
  })

  it("keeps GitHub attempt ids unique when multiple jobs run in one workflow", () => {
    vi.stubEnv("GITHUB_RUN_ID", "77")
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "3")

    const first = newJobId("instant")
    const second = newJobId("instant")

    expect(first).toMatch(/^gh-77-3-\d+$/)
    expect(second).toMatch(/^gh-77-3-\d+$/)
    expect(first).not.toBe(second)
  })

  it("carries the DispatchResult's why through mintInstantJob into jobWhy", async () => {
    await runJob(
      mintInstantJob({
        action: "run",
        duty: "run",
        executable: "run",
        cliArgs: { issue: 5 },
        target: 5,
        why: "also add tests",
      }),
      { cwd: "/x" },
    )
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBe("also add tests")
  })

  it("seeds persona into preloadedData.jobPersona", async () => {
    await runJob(
      { duty: "run", persona: "kody", schedule: "*/5 * * * *", cliArgs: {}, flavor: "scheduled" },
      { cwd: "/x" },
    )
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobPersona).toBe("kody")
  })

  it("uses the duty reference in the stable key for scheduled jobs", async () => {
    await runJob(
      { duty: "duty-tick", executable: "duty-tick", schedule: "*/5 * * * *", cliArgs: {}, flavor: "scheduled" },
      { cwd: "/x" },
    )
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobKey).toBe("scheduled:duty-tick:duty-tick")
  })

  it("falls back to the duty slug as the profile when no executable", async () => {
    await runJob({ duty: "run", schedule: "*/5 * * * *", cliArgs: {}, flavor: "scheduled" }, { cwd: "/x" })
    expect(runExecutableChain.mock.calls[0]![0]).toBe("run")
  })

  it("seeds only job identity (no why/persona) for a bare scheduled job", async () => {
    await runJob({ duty: "run", cliArgs: {}, flavor: "scheduled" }, { cwd: "/x" })
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobFlavor).toBe("scheduled")
    expect(input.preloadedData?.jobWhy).toBeUndefined()
    expect(input.preloadedData?.jobPersona).toBeUndefined()
  })

  it("rejects a job with no duty action or duty", () => {
    expect(() => validateJob({ cliArgs: {}, flavor: "instant" })).toThrow(InvalidJobError)
  })

  it("rejects an executable-only job", () => {
    expect(() => validateJob({ executable: "run", cliArgs: {}, flavor: "instant" })).toThrow(/duty action or duty/)
  })

  it("rejects an unknown flavor", () => {
    expect(() => validateJob({ duty: "run", executable: "run", cliArgs: {}, flavor: "bogus" })).toThrow(InvalidJobError)
  })

  it("defaults cliArgs to an empty object when omitted", () => {
    const j = validateJob({ duty: "run", executable: "run", flavor: "instant" })
    expect(j.cliArgs).toEqual({})
  })
})

describe("mintInstantJob (Phase 2)", () => {
  const dispatch = { action: "fix", duty: "fix", executable: "fix", cliArgs: { pr: 7 }, target: 7 }

  it("maps a DispatchResult to an instant job", () => {
    const job = mintInstantJob(dispatch, { why: "fix the typo" })
    expect(job).toMatchObject({
      executable: "fix",
      duty: "fix",
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
      executable: "duty-tick",
      schedule: "*/5 * * * *",
      persona: "kody",
      cliArgs: { duty: "stale-prs" },
    })
    expect(job).toMatchObject({
      duty: "stale-prs",
      executable: "duty-tick",
      schedule: "*/5 * * * *",
      persona: "kody",
      cliArgs: { duty: "stale-prs" },
      flavor: "scheduled",
    })
  })

  it("defaults cliArgs to empty", () => {
    expect(mintScheduledJob({ duty: "d", executable: "duty-tick" }).cliArgs).toEqual({})
  })

  it("carries the cadence onto ctx.data.jobSchedule so the ledger records when it fired", async () => {
    await runJob(mintScheduledJob({ duty: "duty-tick", executable: "duty-tick", schedule: "7d" }), { cwd: "/x" })
    const [, input] = runExecutableChain.mock.calls.at(-1)!
    expect(input.preloadedData?.jobSchedule).toBe("7d")
    expect(input.preloadedData?.jobFlavor).toBe("scheduled")
    expect(input.preloadedData?.jobDuty).toBe("duty-tick")
    expect(input.preloadedData?.jobExecutable).toBe("duty-tick")
  })
})
