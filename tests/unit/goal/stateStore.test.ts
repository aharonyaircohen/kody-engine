import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/state-backend.js", () => ({
  createStateBackendFromEnv: vi.fn(),
}))

import type { GoalState } from "../../../src/goal/state.js"
import { fetchGoalStateAsync, listGoalStateIdsAsync, putGoalStateAsync } from "../../../src/goal/stateStore.js"
import { createStateBackendFromEnv } from "../../../src/state-backend.js"

const config = { github: { owner: "acme", repo: "widgets" } }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CONVEX_URL = "https://convex.example"
  process.env.KODY_SERVICE_KEY = "service-key"
})

describe("goal state backend", () => {
  it("returns null when the backend has no goal", async () => {
    vi.mocked(createStateBackendFromEnv).mockReturnValue({
      getGoal: vi.fn().mockResolvedValue(null),
    } as never)

    await expect(fetchGoalStateAsync(config, "release")).resolves.toBeNull()
  })

  it("reads a valid backend goal document", async () => {
    vi.mocked(createStateBackendFromEnv).mockReturnValue({
      getGoal: vi.fn().mockResolvedValue({
        state: {
          state: "active",
          extra: { type: "release", blockers: [] },
        },
        updatedAt: "2026-07-17T00:00:00.000Z",
      }),
    } as never)

    await expect(fetchGoalStateAsync(config, "release")).resolves.toMatchObject({
      state: "active",
      extra: { type: "release" },
    })
  })

  it("writes with optimistic concurrency", async () => {
    const getGoal = vi.fn().mockResolvedValue({
      updatedAt: "2026-07-17T00:00:00.000Z",
    })
    const saveGoal = vi.fn()
    vi.mocked(createStateBackendFromEnv).mockReturnValue({
      getGoal,
      saveGoal,
    } as never)
    const state: GoalState = {
      state: "done",
      updatedAt: "2026-07-18T00:00:00.000Z",
      extra: { type: "release", blockers: [] },
    }

    await putGoalStateAsync(config, "release", state)

    expect(saveGoal).toHaveBeenCalledWith("acme/widgets", "release", state, state.updatedAt, "2026-07-17T00:00:00.000Z")
  })

  it("lists backend goal ids in stable order", async () => {
    vi.mocked(createStateBackendFromEnv).mockReturnValue({
      listGoals: vi.fn().mockResolvedValue([{ goalId: "zeta" }, { goalId: "alpha" }]),
    } as never)

    await expect(listGoalStateIdsAsync(config)).resolves.toEqual(["alpha", "zeta"])
  })
})
