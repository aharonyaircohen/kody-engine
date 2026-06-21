import { describe, expect, it } from "vitest"

import type { ManagedGoal } from "../../../src/goal/manager.js"
import type { GoalState } from "../../../src/goal/state.js"
import { advanceManagedGoal } from "../../../src/scripts/advanceManagedGoal.js"
import type { GoalCtx } from "../../../src/scripts/goalCtx.js"
import { saveManagedGoalState } from "../../../src/scripts/saveManagedGoalState.js"

function releaseGoal(overrides: Partial<ManagedGoal> = {}): ManagedGoal {
  return {
    type: "release",
    destination: { outcome: "publish and verify", evidence: ["releasePrExists", "qaPassed"] },
    duties: ["release-prepare", "qa-goal"],
    route: [
      { evidence: "releasePrExists", stage: "prepare", duty: "release-prepare", executable: "release-prepare" },
      { evidence: "qaPassed", stage: "qa", duty: "qa-goal", executable: "qa-goal", args: { issue: 55 } },
    ],
    stage: "prepare",
    facts: {},
    blockers: [],
    ...overrides,
  }
}

function state(extra: Record<string, unknown>): GoalState {
  return { state: "active", extra }
}

function goalExtra(overrides: Partial<ManagedGoal> = {}): Record<string, unknown> {
  return releaseGoal(overrides) as unknown as Record<string, unknown>
}

function fakeCtx(raw: GoalState) {
  return {
    args: { goal: "release-v1-2-3" },
    cwd: "/tmp",
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "anthropic/claude-haiku-4-5-20251001" },
    },
    data: {
      goal: {
        id: "release-v1-2-3",
        state: raw.state,
        defaultBranch: "main",
        raw,
      } satisfies GoalCtx,
    },
    output: { exitCode: 0 },
  } as unknown as Parameters<typeof advanceManagedGoal>[0]
}

function fakeProfile() {
  return {} as unknown as Parameters<typeof advanceManagedGoal>[1]
}

describe("advanceManagedGoal", () => {
  it("sets an in-process duty handoff for first missing evidence", async () => {
    const ctx = fakeCtx(state(goalExtra()))

    await advanceManagedGoal(ctx, fakeProfile())

    expect(ctx.output.nextDispatch).toEqual({
      duty: "release-prepare",
      executable: "release-prepare",
      cliArgs: {},
    })
    const raw = ((ctx.data.goal as GoalCtx).raw as GoalState).extra
    expect(raw.stage).toBe("prepare")
    expect(raw.facts).toEqual({ pendingEvidence: "releasePrExists" })
  })

  it("lets route args reference the active goal id", async () => {
    const ctx = fakeCtx(
      state(
        goalExtra({
          route: [
            {
              evidence: "releasePrExists",
              stage: "prepare",
              duty: "release-prepare",
              executable: "release-prepare",
              args: { goal: { fact: "goalId" } },
            },
          ],
        }),
      ),
    )

    await advanceManagedGoal(ctx, fakeProfile())

    expect(ctx.output.nextDispatch).toEqual({
      duty: "release-prepare",
      executable: "release-prepare",
      cliArgs: { goal: "release-v1-2-3" },
    })
  })

  it("marks the loaded goal done when destination evidence is complete", async () => {
    const ctx = fakeCtx(state(goalExtra({ facts: { releasePrExists: true, qaPassed: true } })))

    await advanceManagedGoal(ctx, fakeProfile())

    expect(ctx.output.nextDispatch).toBeUndefined()
    expect((ctx.data.goal as GoalCtx).state).toBe("done")
    expect(((ctx.data.goal as GoalCtx).raw as GoalState).state).toBe("done")
  })
})

describe("saveManagedGoalState", () => {
  it("stashes changed managed goal state for commitGoalState", async () => {
    const ctx = fakeCtx(state(goalExtra()))

    await advanceManagedGoal(ctx, fakeProfile())
    await saveManagedGoalState(ctx, fakeProfile())

    expect(ctx.data.goalPersistChanged).toBe(true)
    expect((ctx.data.goalPersistState as GoalState).updatedAt).toMatch(/Z$/)
    expect((ctx.data.goalPersistState as GoalState).extra.facts).toEqual({ pendingEvidence: "releasePrExists" })
  })
})
