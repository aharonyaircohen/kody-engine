import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/goal/stateStore.js", () => {
  const put = vi.fn()
  return { putGoalStateAsync: put }
})
vi.mock("../../../src/goal/runLog.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/goal/runLog.js")>("../../../src/goal/runLog.js")
  return {
    ...actual,
    flushGoalRunLogEventsAsync: vi.fn(),
  }
})
const backendMocks = vi.hoisted(() => ({ saveReport: vi.fn() }))
vi.mock("../../../src/state-backend.js", () => ({
  createStateBackendFromEnv: () => ({ saveReport: backendMocks.saveReport }),
}))

import { flushGoalRunLogEventsAsync, stageGoalRunLogEvent } from "../../../src/goal/runLog.js"
import type { GoalState } from "../../../src/goal/state.js"
import { putGoalStateAsync } from "../../../src/goal/stateStore.js"
import type { Context, Profile } from "../../../src/implementations/types.js"
import { commitGoalState } from "../../../src/scripts/commitGoalState.js"
import type { GoalCtx } from "../../../src/scripts/goalCtx.js"

const putGoalStateMock = vi.mocked(putGoalStateAsync)
const flushGoalRunLogEventsMock = vi.mocked(flushGoalRunLogEventsAsync)

function goalState(overrides: Partial<GoalState["extra"]> = {}): GoalState {
  return {
    state: "active",
    updatedAt: "2026-06-25T20:00:00.000Z",
    extra: {
      type: "release",
      destination: { outcome: "publish and verify", evidence: ["releasePrExists"] },
      capabilities: ["release-prepare"],
      route: [
        {
          evidence: "releasePrExists",
          stage: "prepare",
          capability: "release-prepare",
          implementation: "release-prepare",
        },
      ],
      stage: "prepare",
      facts: { pendingEvidence: "releasePrExists" },
      blockers: [],
      saveReport: true,
      ...overrides,
    },
  }
}

function fakeCtx(raw: GoalState, data: Record<string, unknown> = {}): Context {
  return {
    args: { goal: "release-v1-2-3" },
    cwd: "/repo",
    config: {
      github: { owner: "o", repo: "r" },
      git: { defaultBranch: "main" },
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      agent: { model: "anthropic/claude-haiku-4-5-20251001" },
    },
    data: {
      ...data,
      goal: {
        id: "release-v1-2-3",
        state: raw.state,
        defaultBranch: "main",
        raw,
      } satisfies GoalCtx,
    },
    output: { exitCode: 0 },
  } as unknown as Context
}

function fakeProfile(): Profile {
  return { name: "goal-manager" } as Profile
}

describe("commitGoalState report refresh", () => {
  const originalGithubEventName = process.env.GITHUB_EVENT_NAME
  const originalGithubActor = process.env.GITHUB_ACTOR

  beforeEach(() => {
    putGoalStateMock.mockReset()
    flushGoalRunLogEventsMock.mockReset()
    backendMocks.saveReport.mockReset()
    delete process.env.GITHUB_EVENT_NAME
    delete process.env.GITHUB_ACTOR
  })

  afterEach(() => {
    if (originalGithubEventName === undefined) {
      delete process.env.GITHUB_EVENT_NAME
    } else {
      process.env.GITHUB_EVENT_NAME = originalGithubEventName
    }
    if (originalGithubActor === undefined) {
      delete process.env.GITHUB_ACTOR
    } else {
      process.env.GITHUB_ACTOR = originalGithubActor
    }
  })

  it("writes the goal dashboard report after changed goal state is persisted", async () => {
    const updated = goalState({ facts: { pendingEvidence: "releasePrExists" } })
    const ctx = fakeCtx(updated, {
      goalPersistChanged: true,
      goalPersistState: updated,
    })
    stageGoalRunLogEvent(ctx.data, "release-v1-2-3", {
      source: "goal-manager",
      event: "goal.tick.dispatch",
      goalState: "active",
      stage: "prepare",
      status: "dispatch",
      reason: "dispatch release-prepare for releasePrExists",
      goal: { stage: "prepare", requiredEvidence: ["releasePrExists"], missingEvidence: ["releasePrExists"] },
      decision: { kind: "dispatch", reason: "dispatch release-prepare for releasePrExists" },
    })

    await commitGoalState(ctx, fakeProfile(), null)

    expect(putGoalStateMock).toHaveBeenCalledOnce()
    expect(backendMocks.saveReport).toHaveBeenCalledOnce()
    expect(putGoalStateMock.mock.invocationCallOrder[0]).toBeLessThan(
      backendMocks.saveReport.mock.invocationCallOrder[0]!,
    )
    const [, , runId, , body] = backendMocks.saveReport.mock.calls[0]!
    const path = `reports/release-v1-2-3/runs/${runId}.md`
    expect(path).toMatch(/^reports\/release-v1-2-3\/runs\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.md$/)
    expect(body).toContain("- Event: goal.tick.dispatch")
    expect(body).toContain("- Next step: dispatch")
    expect(body).toContain("- Triggered by:")
    expect(body).toContain("- Decided by: goal-manager")
    expect(body).toContain("- Dispatched by: goal-manager")
    expect(ctx.data.goalReports).toEqual([{ slug: "release-v1-2-3", path, changed: true }])
    expect(flushGoalRunLogEventsMock).toHaveBeenCalledOnce()
  })

  it("refreshes the goal dashboard report for unchanged wait decisions", async () => {
    const raw = goalState()
    const ctx = fakeCtx(raw, { goalPersistChanged: false })
    stageGoalRunLogEvent(ctx.data, "release-v1-2-3", {
      source: "goal-manager",
      event: "goal.tick.wait",
      goalState: "active",
      stage: "waiting",
      status: "wait",
      reason: "waiting for labelled tasks",
      goal: {
        stage: "waiting",
        requiredEvidence: ["labelledTasksComplete"],
        missingEvidence: ["labelledTasksComplete"],
      },
      decision: { kind: "wait", reason: "waiting for labelled tasks" },
    })

    await commitGoalState(ctx, fakeProfile(), null)

    expect(putGoalStateMock).not.toHaveBeenCalled()
    expect(backendMocks.saveReport).toHaveBeenCalledOnce()
    const [, , runId, , body] = backendMocks.saveReport.mock.calls[0]!
    const path = `reports/release-v1-2-3/runs/${runId}.md`
    expect(path).toMatch(/^reports\/release-v1-2-3\/runs\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.md$/)
    expect(body).toContain("- Event: goal.tick.wait")
    expect(body).toContain("- Next step: wait")
    expect(body).toContain("- Reason: waiting for labelled tasks")
    expect(body).toContain("## Capability Evidence\n- none")
    expect(flushGoalRunLogEventsMock).toHaveBeenCalledOnce()
  })

  it("does not write the report when changed goal state persistence fails", async () => {
    const updated = goalState()
    const ctx = fakeCtx(updated, {
      goalPersistChanged: true,
      goalPersistState: updated,
    })
    putGoalStateMock.mockImplementationOnce(() => {
      throw new Error("state write failed")
    })

    await commitGoalState(ctx, fakeProfile(), null)

    expect(backendMocks.saveReport).not.toHaveBeenCalled()
    expect(flushGoalRunLogEventsMock).toHaveBeenCalledOnce()
  })
})
