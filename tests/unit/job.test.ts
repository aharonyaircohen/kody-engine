import { beforeEach, describe, expect, it, vi } from "vitest"

// Hoist-safe mock of the executor so runJob is tested in isolation (no real
// executable spins up). Mirrors tests/unit/dispatchJobFileTicks.routing.test.ts.
const { runExecutableChain } = vi.hoisted(() => ({ runExecutableChain: vi.fn() }))
vi.mock("../../src/executor.js", () => ({ runExecutableChain }))

import { InvalidJobError, runJob, validateJob } from "../../src/job.js"

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

  it("seeds inline why into preloadedData.jobIntent", async () => {
    await runJob({ executable: "fix", why: "fix the flaky test", cliArgs: {}, flavor: "instant" }, { cwd: "/x" })
    const [, input] = runExecutableChain.mock.calls[0]!
    expect(input.preloadedData?.jobIntent).toBe("fix the flaky test")
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
