import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/goal/stateStore.js", () => ({
  fetchGoalState: vi.fn(),
}))

import type { Context, Profile } from "../../../src/agent-actions/types.js"
import type { GoalState } from "../../../src/goal/state.js"
import { fetchGoalState } from "../../../src/goal/stateStore.js"
import { loadGoalState } from "../../../src/scripts/loadGoalState.js"

function goalState(): GoalState {
  return {
    state: "active",
    extra: {
      type: "release",
      destination: { outcome: "ship", evidence: ["ready"] },
      agentResponsibilities: ["release-prepare"],
      route: [],
      facts: {},
      blockers: [],
    },
  }
}

function fakeCtx() {
  return {
    args: { goal: "release-v1" },
    cwd: "/tmp/repo",
    config: {
      git: { defaultBranch: "main" },
      github: { owner: "acme", repo: "widgets" },
    },
    data: {},
    output: {},
  } as unknown as Context
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.KODY_GOAL_STATE_RETRY_DELAYS_MS = "0,0"
})

afterEach(() => {
  delete process.env.KODY_GOAL_STATE_RETRY_DELAYS_MS
})

describe("loadGoalState", () => {
  it("retries state repo reads before treating a goal as missing", async () => {
    const state = goalState()
    vi.mocked(fetchGoalState).mockReturnValueOnce(null).mockReturnValueOnce(state)

    const ctx = fakeCtx()
    await loadGoalState(ctx, {} as unknown as Profile)

    expect(fetchGoalState).toHaveBeenCalledTimes(2)
    expect(fetchGoalState).toHaveBeenCalledWith(
      expect.objectContaining({
        github: { owner: "acme", repo: "widgets" },
      }),
      "release-v1",
      "/tmp/repo",
    )
    expect(ctx.skipAgent).toBeUndefined()
    expect(ctx.output.reason).toBeUndefined()
    expect(ctx.data.goal).toEqual({
      id: "release-v1",
      state: "active",
      raw: state,
      defaultBranch: "main",
    })
  })

  it("still exits cleanly when goal state is truly missing", async () => {
    vi.mocked(fetchGoalState).mockReturnValue(null)

    const ctx = fakeCtx()
    await loadGoalState(ctx, {} as unknown as Profile)

    expect(fetchGoalState).toHaveBeenCalledTimes(3)
    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.output.reason).toBe("no goal state to tick")
  })
})
