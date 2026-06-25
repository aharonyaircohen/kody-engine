import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Hoist-safe mock of the executor so runJob is tested in isolation (no real
// agentAction spins up). Mirrors tests/unit/dispatchAgentResponsibilityFileTicks.routing.test.ts.
const { runAgentActionChain } = vi.hoisted(() => ({ runAgentActionChain: vi.fn() }))
vi.mock("../../src/executor.js", () => ({ runAgentActionChain }))

import {
  DEFAULT_INSTANT_AGENT,
  InvalidJobError,
  mintInstantJob,
  mintScheduledJob,
  newJobId,
  runJob,
  validateJob,
} from "../../src/job.js"

describe("runJob (Phase 1 seam)", () => {
  beforeEach(() => {
    runAgentActionChain.mockReset()
    runAgentActionChain.mockResolvedValue({ exitCode: 0 })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("lowers an instant job onto runAgentActionChain with its agentAction + cliArgs", async () => {
    await runJob(
      { agentResponsibility: "run", agentAction: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    expect(runAgentActionChain).toHaveBeenCalledTimes(1)
    const [profile, input] = runAgentActionChain.mock.calls[0]!
    expect(profile).toBe("run")
    expect(input.cliArgs).toEqual({ issue: 42 })
    expect(input.cwd).toBe("/x")
    expect(input.preloadedData?.jobAgentResponsibility).toBe("run")
  })

  it("lowers an action-only instant job through the agentResponsibility action registry", async () => {
    await runJob({ action: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" }, { cwd: "/x" })
    const [profile, input] = runAgentActionChain.mock.calls[0]!
    expect(profile).toBe("run")
    expect(input.cliArgs).toEqual({ issue: 42 })
    expect(input.preloadedData?.jobAction).toBe("run")
    expect(input.preloadedData?.jobAgentResponsibility).toBe("run")
    expect(input.preloadedData?.jobAgentAction).toBe("run")
  })

  it("resolves a agentResponsibility-only job to the agentResponsibility-selected agentAction", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-agentResponsibility-job-"))
    const dutyDir = path.join(cwd, ".kody", "agent-responsibilities", "ci-health")
    fs.mkdirSync(dutyDir, { recursive: true })
    fs.writeFileSync(
      path.join(dutyDir, "profile.json"),
      JSON.stringify({ name: "ci-health", action: "ci-health", agentAction: "ci-check", agent: "kody" }),
    )
    fs.writeFileSync(path.join(dutyDir, "agent-responsibility.md"), "# CI Health\n")

    await runJob(
      {
        agentResponsibility: "ci-health",
        cliArgs: { pr: 456, goal: "release-aguy", evidence: "mainDeployPrGreen" },
        flavor: "instant",
      },
      { cwd },
    )

    const [profile, input] = runAgentActionChain.mock.calls[0]!
    expect(profile).toBe("ci-check")
    expect(input.cliArgs).toEqual({ pr: 456, goal: "release-aguy", evidence: "mainDeployPrGreen" })
    expect(input.preloadedData?.jobAgentResponsibility).toBe("ci-health")
    expect(input.preloadedData?.jobAgentAction).toBe("ci-check")
  })
  it("preserves agentResponsibility identity without injecting agentResponsibility args when agentAction is explicit", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-goal-handoff-"))
    const dutyDir = path.join(cwd, ".kody", "agent-responsibilities", "company-graph")
    fs.mkdirSync(dutyDir, { recursive: true })
    fs.writeFileSync(path.join(dutyDir, "profile.json"), JSON.stringify({ name: "company-graph" }))
    fs.writeFileSync(path.join(dutyDir, "agent-responsibility.md"), "# Company Graph\n")
    await runJob(
      {
        agentResponsibility: "company-graph",
        agentAction: "company-graph",
        cliArgs: { goal: "hourly-monitor-goal-smoke" },
        flavor: "instant",
      },
      { cwd },
    )
    const [profile, input] = runAgentActionChain.mock.calls[0]!
    expect(profile).toBe("company-graph")
    expect(input.cliArgs).toEqual({ goal: "hourly-monitor-goal-smoke" })
    expect(input.preloadedData?.jobAgentResponsibility).toBe("company-graph")
    expect(input.preloadedData?.jobAgentAction).toBe("company-graph")
  })

  it("seeds inline why into preloadedData.jobWhy", async () => {
    await runJob(
      { agentResponsibility: "fix", agentAction: "fix", why: "fix the flaky test", cliArgs: {}, flavor: "instant" },
      { cwd: "/x" },
    )
    const [, input] = runAgentActionChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBe("fix the flaky test")
    expect(input.preloadedData?.jobIntent).toContain("Apply review feedback")
  })

  it("does not seed jobWhy for an empty why string", async () => {
    await runJob(
      { agentResponsibility: "run", agentAction: "run", why: "", cliArgs: {}, flavor: "instant" },
      { cwd: "/x" },
    )
    const [, input] = runAgentActionChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBeUndefined()
  })

  it("always seeds a jobId + flavor so the run can be recorded in the task ledger", async () => {
    await runJob(
      { agentResponsibility: "run", agentAction: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    const [, input] = runAgentActionChain.mock.calls[0]!
    expect(typeof input.preloadedData?.jobId).toBe("string")
    expect(input.preloadedData?.jobKey).toBe("instant:run:42")
    expect(input.preloadedData?.jobFlavor).toBe("instant")
    expect(input.preloadedData?.jobAgentAction).toBe("run")
    expect(input.preloadedData?.jobTarget).toBe(42)
  })

  it("keeps the same stable job key for retries of the same target + agentAction", async () => {
    await runJob(
      { agentResponsibility: "run", agentAction: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )
    await runJob(
      { agentResponsibility: "run", agentAction: "run", target: 42, cliArgs: { issue: 42 }, flavor: "instant" },
      { cwd: "/x" },
    )

    const first = runAgentActionChain.mock.calls[0]![1].preloadedData
    const second = runAgentActionChain.mock.calls[1]![1].preloadedData
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
        agentResponsibility: "run",
        agentAction: "run",
        cliArgs: { issue: 5 },
        target: 5,
        why: "also add tests",
      }),
      { cwd: "/x" },
    )
    const [, input] = runAgentActionChain.mock.calls[0]!
    expect(input.preloadedData?.jobWhy).toBe("also add tests")
  })

  it("seeds agent into preloadedData.jobAgent", async () => {
    await runJob(
      { agentResponsibility: "run", agent: "kody", schedule: "*/5 * * * *", cliArgs: {}, flavor: "scheduled" },
      { cwd: "/x" },
    )
    const [, input] = runAgentActionChain.mock.calls[0]!
    expect(input.preloadedData?.jobAgent).toBe("kody")
  })

  it("uses the agentResponsibility reference in the stable key for scheduled jobs", async () => {
    await runJob(
      {
        agentResponsibility: "agent-responsibility-tick",
        agentAction: "agent-responsibility-tick",
        schedule: "*/5 * * * *",
        cliArgs: {},
        flavor: "scheduled",
      },
      { cwd: "/x" },
    )
    const [, input] = runAgentActionChain.mock.calls[0]!
    expect(input.preloadedData?.jobKey).toBe("scheduled:agent-responsibility-tick:agent-responsibility-tick")
  })

  it("falls back to the agentResponsibility slug as the profile when no agentAction", async () => {
    await runJob(
      { agentResponsibility: "run", schedule: "*/5 * * * *", cliArgs: {}, flavor: "scheduled" },
      { cwd: "/x" },
    )
    expect(runAgentActionChain.mock.calls[0]![0]).toBe("run")
  })

  it("seeds only job identity (no why/agent) for a bare scheduled job", async () => {
    await runJob({ agentResponsibility: "run", cliArgs: {}, flavor: "scheduled" }, { cwd: "/x" })
    const [, input] = runAgentActionChain.mock.calls[0]!
    expect(input.preloadedData?.jobFlavor).toBe("scheduled")
    expect(input.preloadedData?.jobWhy).toBeUndefined()
    expect(input.preloadedData?.jobAgent).toBeUndefined()
  })

  it("rejects a job with no agentResponsibility action or agentResponsibility", () => {
    expect(() => validateJob({ cliArgs: {}, flavor: "instant" })).toThrow(InvalidJobError)
  })

  it("rejects an agentAction-only job", () => {
    expect(() => validateJob({ agentAction: "run", cliArgs: {}, flavor: "instant" })).toThrow(
      /agentResponsibility action or agentResponsibility/,
    )
  })

  it("rejects an unknown flavor", () => {
    expect(() => validateJob({ agentResponsibility: "run", agentAction: "run", cliArgs: {}, flavor: "bogus" })).toThrow(
      InvalidJobError,
    )
  })

  it("defaults cliArgs to an empty object when omitted", () => {
    const j = validateJob({ agentResponsibility: "run", agentAction: "run", flavor: "instant" })
    expect(j.cliArgs).toEqual({})
  })
})

describe("mintInstantJob (Phase 2)", () => {
  const dispatch = { action: "fix", agentResponsibility: "fix", agentAction: "fix", cliArgs: { pr: 7 }, target: 7 }

  it("maps a DispatchResult to an instant job", () => {
    const job = mintInstantJob(dispatch, { why: "fix the typo" })
    expect(job).toMatchObject({
      agentAction: "fix",
      agentResponsibility: "fix",
      target: 7,
      cliArgs: { pr: 7 },
      why: "fix the typo",
      flavor: "instant",
    })
  })

  it("defaults agent to the standard agent", () => {
    expect(mintInstantJob(dispatch).agent).toBe(DEFAULT_INSTANT_AGENT)
  })

  it("lets the caller override the agent", () => {
    expect(mintInstantJob(dispatch, { agent: "reviewer" }).agent).toBe("reviewer")
  })

  it("produces a job that runJob can run", async () => {
    runAgentActionChain.mockResolvedValue({ exitCode: 0 })
    await runJob(mintInstantJob(dispatch, { why: "x" }), { cwd: "/x" })
    expect(runAgentActionChain.mock.calls.at(-1)![0]).toBe("fix")
  })
})

describe("mintScheduledJob (Phase 2)", () => {
  it("maps a due agentResponsibility slug to a scheduled job", () => {
    const job = mintScheduledJob({
      agentResponsibility: "stale-prs",
      agentAction: "agent-responsibility-tick",
      schedule: "*/5 * * * *",
      agent: "kody",
      cliArgs: { agentResponsibility: "stale-prs" },
    })
    expect(job).toMatchObject({
      agentResponsibility: "stale-prs",
      agentAction: "agent-responsibility-tick",
      schedule: "*/5 * * * *",
      agent: "kody",
      cliArgs: { agentResponsibility: "stale-prs" },
      flavor: "scheduled",
    })
  })

  it("defaults cliArgs to empty", () => {
    expect(mintScheduledJob({ agentResponsibility: "d", agentAction: "agent-responsibility-tick" }).cliArgs).toEqual({})
  })

  it("carries the cadence onto ctx.data.jobSchedule so the ledger records when it fired", async () => {
    await runJob(
      mintScheduledJob({
        agentResponsibility: "agent-responsibility-tick",
        agentAction: "agent-responsibility-tick",
        schedule: "7d",
      }),
      { cwd: "/x" },
    )
    const [, input] = runAgentActionChain.mock.calls.at(-1)!
    expect(input.preloadedData?.jobSchedule).toBe("7d")
    expect(input.preloadedData?.jobFlavor).toBe("scheduled")
    expect(input.preloadedData?.jobAgentResponsibility).toBe("agent-responsibility-tick")
    expect(input.preloadedData?.jobAgentAction).toBe("agent-responsibility-tick")
  })

  it("carries saveReport onto ctx.data.jobSaveReport", async () => {
    await runJob(
      mintScheduledJob({
        agentResponsibility: "model-health-audit",
        agentAction: "model-health-audit",
        saveReport: true,
      }),
      { cwd: "/x" },
    )

    const [, input] = runAgentActionChain.mock.calls.at(-1)!
    expect(input.preloadedData?.jobSaveReport).toBe(true)
  })
})
