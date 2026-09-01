import { beforeEach, describe, expect, it, vi } from "vitest"

const backend = vi.hoisted(() => ({ saveAgencyRun: vi.fn() }))
vi.mock("../../src/state-backend.js", () => ({
  createStateBackendFromEnv: () => backend,
}))

import {
  finalizeStagedRunIndexRowsAsync,
  mergeRunIndexRow,
  runIndexRowFromJobContext,
  stageRunIndexFinalization,
  upsertRunIndexRowBestEffortAsync,
} from "../../src/runIndex.js"

const config = { github: { owner: "o", repo: "r" } }

describe("run index backend", () => {
  beforeEach(() => vi.clearAllMocks())

  it("keeps a compact newest-first pure projection", () => {
    const first = mergeRunIndexRow(null, {
      version: 1,
      id: "workflow:ship:run-1",
      subjectType: "workflow",
      subjectId: "ship",
      status: "running",
      title: "Ship",
      updatedAt: "2026-07-05T10:00:00.000Z",
    })
    const second = mergeRunIndexRow(JSON.stringify(first), {
      ...first.runs[0]!,
      status: "success",
      updatedAt: "2026-07-05T10:02:00.000Z",
    })
    expect(second.runs).toHaveLength(1)
    expect(second.runs[0]).toMatchObject({ status: "success" })
  })

  it("persists a run directly to the backend", async () => {
    const row = {
      version: 1 as const,
      id: "goal:release:run-1",
      subjectType: "goal" as const,
      subjectId: "release",
      status: "running" as const,
      title: "release",
      updatedAt: "2026-07-05T10:00:00.000Z",
    }
    await upsertRunIndexRowBestEffortAsync(config, "/repo", row)
    expect(backend.saveAgencyRun).toHaveBeenCalledWith("o/r", row.id, "goal", "release", row, row.updatedAt)
  })

  it("does not fail the agency when best-effort run persistence is temporarily unavailable", async () => {
    backend.saveAgencyRun.mockRejectedValueOnce(new Error("GitHub Actions identity request failed (503)"))
    const row = {
      version: 1 as const,
      id: "workflow:ci-repair:run-1",
      subjectType: "workflow" as const,
      subjectId: "ci-repair",
      status: "running" as const,
      title: "CI Repair",
      updatedAt: "2026-08-06T15:37:01.000Z",
    }

    await expect(upsertRunIndexRowBestEffortAsync(config, "/repo", row)).resolves.toBeUndefined()
  })

  it("finalizes staged rows through the backend", async () => {
    const data: Record<string, unknown> = {}
    stageRunIndexFinalization(data, {
      version: 1,
      id: "goal:release:run-1",
      subjectType: "goal",
      subjectId: "release",
      status: "running",
      title: "release",
      updatedAt: "2026-07-05T10:00:00.000Z",
    })
    await finalizeStagedRunIndexRowsAsync(config, "/repo", data, {
      status: "failed",
      updatedAt: "2026-07-05T10:05:00.000Z",
      reason: "failed",
      output: { verdict: "retry" },
      usage: {
        version: 1,
        tokens: { input: 100, output: 20, cacheRead: 30, cacheCreate: 0, total: 150 },
        costUsd: 0.5,
        agentRuns: 1,
        turns: 4,
        byModel: {},
      },
    })
    expect(backend.saveAgencyRun).toHaveBeenCalledWith(
      "o/r",
      "goal:release:run-1",
      "goal",
      "release",
      expect.objectContaining({
        status: "failed",
        summary: "failed",
        output: { verdict: "retry" },
        usage: expect.objectContaining({ tokens: expect.objectContaining({ total: 150 }), turns: 4 }),
      }),
      "2026-07-05T10:05:00.000Z",
    )
  })

  it("builds workflow rows from runtime job context", () => {
    const row = runIndexRowFromJobContext({
      profileName: "release-prepare",
      profile: {
        name: "release-prepare",
        describe: "Prepare release.",
        agent: "release",
      },
      status: "success",
      startedAt: "2026-07-05T10:00:00.000Z",
      updatedAt: "2026-07-05T10:01:00.000Z",
      usage: {
        version: 1,
        tokens: { input: 100, output: 20, cacheRead: 30, cacheCreate: 0, total: 150 },
        costUsd: 0.5,
        agentRuns: 1,
        turns: 4,
        byModel: {},
      },
      data: {
        runSubjectType: "capability",
        runSubjectId: "prepare-release",
        jobId: "job-1",
        parentRunId: "workflow:web-release:run-1",
        capabilityRevision: "cap-rev",
        implementationRevision: "impl-rev",
        capabilityOutput: { lesson: "Use signed releases." },
      },
    })
    expect(row).toMatchObject({
      subjectType: "capability",
      subjectId: "prepare-release",
      implementation: "release-prepare",
      parentRunId: "workflow:web-release:run-1",
      capabilityRevision: "cap-rev",
      implementationRevision: "impl-rev",
      output: { lesson: "Use signed releases." },
      usage: expect.objectContaining({ tokens: expect.objectContaining({ total: 150 }), turns: 4 }),
    })
  })
})
