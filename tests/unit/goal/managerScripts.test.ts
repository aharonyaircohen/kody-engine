import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import type { ManagedGoal } from "../../../src/goal/manager.js"
import type { GoalState } from "../../../src/goal/state.js"
import { gh } from "../../../src/issue.js"
import { advanceManagedGoal } from "../../../src/scripts/advanceManagedGoal.js"
import type { GoalCtx } from "../../../src/scripts/goalCtx.js"
import { saveManagedGoalState } from "../../../src/scripts/saveManagedGoalState.js"

const ghMock = vi.mocked(gh)

function releaseGoal(overrides: Partial<ManagedGoal> = {}): ManagedGoal {
  return {
    type: "release",
    destination: { outcome: "publish and verify", evidence: ["releasePrExists", "qaPassed"] },
    capabilities: ["release-prepare", "qa-goal"],
    route: [
      {
        evidence: "releasePrExists",
        stage: "prepare",
        capability: "release-prepare",
        executable: "release-prepare",
      },
      {
        evidence: "qaPassed",
        stage: "qa",
        capability: "qa-goal",
        executable: "qa-goal",
        args: { issue: 55 },
      },
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
  beforeEach(() => {
    ghMock.mockReset()
  })

  it("sets an in-process capability handoff for first missing evidence", async () => {
    const ctx = fakeCtx(state(goalExtra()))

    await advanceManagedGoal(ctx, fakeProfile())

    expect(ctx.output.nextDispatch).toEqual({
      capability: "release-prepare",
      executable: "release-prepare",
      cliArgs: {},
      resultTarget: { type: "goal", id: "release-v1-2-3", evidence: "releasePrExists" },
    })
    const raw = ((ctx.data.goal as GoalCtx).raw as GoalState).extra
    expect(raw.stage).toBe("prepare")
    expect(raw.facts).toEqual({ pendingEvidence: "releasePrExists" })
  })

  it("retries the active pending evidence instead of waiting forever", async () => {
    const ctx = fakeCtx(state(goalExtra({ stage: "prepare", facts: { pendingEvidence: "releasePrExists" } })))

    await advanceManagedGoal(ctx, fakeProfile())

    expect(ctx.output.nextDispatch).toEqual({
      capability: "release-prepare",
      executable: "release-prepare",
      cliArgs: {},
      resultTarget: { type: "goal", id: "release-v1-2-3", evidence: "releasePrExists" },
    })
    const raw = ((ctx.data.goal as GoalCtx).raw as GoalState).extra
    expect(raw.stage).toBe("prepare")
    expect(raw.facts).toEqual({ pendingEvidence: "releasePrExists" })
  })

  it("dispatches capability-only route steps without leaking implementation names", async () => {
    const ctx = fakeCtx(
      state(
        goalExtra({
          route: [
            {
              evidence: "releasePrExists",
              stage: "prepare",
              capability: "release-prepare",
            },
          ],
        }),
      ),
    )

    await advanceManagedGoal(ctx, fakeProfile())

    expect(ctx.output.nextDispatch).toEqual({
      capability: "release-prepare",
      cliArgs: {},
      resultTarget: { type: "goal", id: "release-v1-2-3", evidence: "releasePrExists" },
    })
  })

  it("lets route args reference the active goal id", async () => {
    const ctx = fakeCtx(
      state(
        goalExtra({
          route: [
            {
              evidence: "releasePrExists",
              stage: "prepare",
              capability: "release-prepare",
              executable: "release-prepare",
              args: { goal: { fact: "goalId" } },
            },
          ],
        }),
      ),
    )

    await advanceManagedGoal(ctx, fakeProfile())

    expect(ctx.output.nextDispatch).toEqual({
      capability: "release-prepare",
      executable: "release-prepare",
      cliArgs: { goal: "release-v1-2-3" },
      resultTarget: { type: "goal", id: "release-v1-2-3", evidence: "releasePrExists" },
    })
  })

  it("creates an issue fact before dispatching a release route that needs issue", async () => {
    ghMock.mockReturnValueOnce(JSON.stringify([])).mockReturnValueOnce("https://github.com/o/r/issues/321")

    const ctx = fakeCtx(
      state({
        type: "release",
        destination: { outcome: "Publish Kody Dashboard to production safely." },
      }),
    )

    await advanceManagedGoal(ctx, fakeProfile())

    expect(ctx.output.nextDispatch).toEqual({
      capability: "release",
      executable: "release-prepare",
      cliArgs: { issue: 321, goal: "release-v1-2-3" },
      resultTarget: { type: "goal", id: "release-v1-2-3", evidence: "releasePrExists" },
    })
    expect(((ctx.data.goal as GoalCtx).raw as GoalState).extra.facts).toMatchObject({
      issue: 321,
      pendingEvidence: "releasePrExists",
    })
    expect(ghMock.mock.calls[0]?.[0]).toEqual([
      "issue",
      "list",
      "--state",
      "all",
      "--limit",
      "100",
      "--json",
      "number,body",
    ])
    expect(ghMock.mock.calls[1]?.[0]).toEqual([
      "issue",
      "create",
      "--title",
      "Release: Publish Kody Dashboard to production safely.",
      "--body-file",
      "-",
    ])
  })

  it("reuses an existing managed-goal issue marker", async () => {
    ghMock.mockReturnValueOnce(
      JSON.stringify([{ number: 654, body: "hello\n<!-- kody-managed-goal: release-v1-2-3 -->" }]),
    )

    const ctx = fakeCtx(
      state({
        type: "release",
        destination: { outcome: "Publish Kody Dashboard to production safely." },
      }),
    )

    await advanceManagedGoal(ctx, fakeProfile())

    expect(ctx.output.nextDispatch).toEqual({
      capability: "release",
      executable: "release-prepare",
      cliArgs: { issue: 654, goal: "release-v1-2-3" },
      resultTarget: { type: "goal", id: "release-v1-2-3", evidence: "releasePrExists" },
    })
    expect(ghMock).toHaveBeenCalledTimes(1)
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
