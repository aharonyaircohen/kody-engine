import { beforeEach, describe, expect, it, vi } from "vitest"

const backend = vi.hoisted(() => ({
  appendDailyLog: vi.fn(),
  appendRunEvent: vi.fn(),
}))
const runIndex = vi.hoisted(() => ({
  upsertRunIndexRowBestEffortAsync: vi.fn(),
}))

vi.mock("../../../src/state-backend.js", () => ({
  createStateBackendFromEnv: () => backend,
}))
vi.mock("../../../src/runIndex.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/runIndex.js")>()),
  upsertRunIndexRowBestEffortAsync: runIndex.upsertRunIndexRowBestEffortAsync,
}))

import {
  flushGoalRunLogEventsAsync,
  goalRunLogChange,
  goalRunLogSnapshot,
  stageGoalRunLogEvent,
} from "../../../src/goal/runLog.js"

const config = {
  quality: { typecheck: "", lint: "", testUnit: "", format: "" },
  git: { defaultBranch: "main" },
  github: { owner: "o", repo: "r" },
  agent: { model: "test" },
}

describe("goal run logs backend", () => {
  beforeEach(() => vi.clearAllMocks())

  it("persists events and the run projection to Convex", async () => {
    const data: Record<string, unknown> = { jobId: "run-1" }
    stageGoalRunLogEvent(
      data,
      "web-release",
      {
        source: "goal-manager",
        event: "goal.tick.dispatch",
        goalType: "release",
        status: "dispatch",
      },
      "2026-07-17T10:00:00.000Z",
    )

    await flushGoalRunLogEventsAsync(config, "/repo", data)

    expect(backend.appendDailyLog).toHaveBeenCalledWith(
      "o/r",
      "events",
      "2026-07-17",
      expect.objectContaining({ event: "goal.tick.dispatch" }),
    )
    expect(backend.appendRunEvent).toHaveBeenCalledWith(
      "o/r",
      "goal:web-release:run-1",
      "web-release",
      expect.objectContaining({ event: "goal.tick.dispatch" }),
      "2026-07-17T10:00:00.000Z",
    )
    expect(runIndex.upsertRunIndexRowBestEffortAsync).toHaveBeenCalled()
  })

  it("summarizes managed goal state for audit readers", () => {
    const snapshot = goalRunLogSnapshot("release", "active", {
      type: "release",
      destination: { outcome: "ship", evidence: ["published"] },
      capabilities: ["release"],
      route: [],
      blockers: [],
      facts: { published: false },
      evidenceState: {},
    })
    expect(snapshot).toMatchObject({
      id: "release",
      missingEvidence: ["published"],
    })
  })

  it("describes state changes", () => {
    expect(
      goalRunLogChange({ state: "active", blockers: [] }, { state: "blocked", blockers: ["approval"] }),
    ).toMatchObject({
      state: { from: "active", to: "blocked" },
      blockers: { added: ["approval"] },
    })
  })
})
