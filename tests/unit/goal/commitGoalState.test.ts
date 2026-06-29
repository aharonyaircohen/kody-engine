import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/goal/stateStore.js", () => ({
  putGoalState: vi.fn(),
}))
vi.mock("../../../src/goal/runLog.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/goal/runLog.js")>("../../../src/goal/runLog.js")
  return {
    ...actual,
    flushGoalRunLogEvents: vi.fn(),
  }
})
vi.mock("../../../src/stateRepo.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/stateRepo.js")>("../../../src/stateRepo.js")
  return {
    ...actual,
    writeStateText: vi.fn(),
  }
})

import type { Context, Profile } from "../../../src/executables/types.js"
import { flushGoalRunLogEvents, stageGoalRunLogEvent } from "../../../src/goal/runLog.js"
import type { GoalState } from "../../../src/goal/state.js"
import { putGoalState } from "../../../src/goal/stateStore.js"
import { commitGoalState } from "../../../src/scripts/commitGoalState.js"
import type { GoalCtx } from "../../../src/scripts/goalCtx.js"
import { writeStateText } from "../../../src/stateRepo.js"

const putGoalStateMock = vi.mocked(putGoalState)
const flushGoalRunLogEventsMock = vi.mocked(flushGoalRunLogEvents)
const writeStateTextMock = vi.mocked(writeStateText)

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
          executable: "release-prepare",
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
      state: { repo: "o/kody-state", path: "r" },
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
  beforeEach(() => {
    putGoalStateMock.mockReset()
    flushGoalRunLogEventsMock.mockReset()
    writeStateTextMock.mockReset()
    // triggerContext() reads GITHUB_EVENT_NAME / GITHUB_ACTOR /
    // GITHUB_EVENT_PATH and uses them to label the report's
    // `Triggered by` line. The CI runner exports GITHUB_EVENT_NAME,
    // which would otherwise flip the expected "local run" into
    // "GitHub issue comment". Match runLog.test.ts and clear the
    // vars so each case starts from the same local-run baseline.
    delete process.env.GITHUB_EVENT_NAME
    delete process.env.GITHUB_ACTOR
    delete process.env.GITHUB_EVENT_PATH
    delete process.env.GITHUB_RUN_ID
    delete process.env.GITHUB_RUN_ATTEMPT
    delete process.env.GITHUB_REPOSITORY
    delete process.env.GITHUB_SERVER_URL
    delete process.env.GITHUB_WORKFLOW
    delete process.env.GITHUB_JOB
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
    expect(writeStateTextMock).toHaveBeenCalledOnce()
    expect(putGoalStateMock.mock.invocationCallOrder[0]).toBeLessThan(writeStateTextMock.mock.invocationCallOrder[0]!)
    const [, , path, body] = writeStateTextMock.mock.calls[0]!
    expect(path).toMatch(/^reports\/release-v1-2-3\/runs\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.md$/)
    expect(body).toContain("- Event: goal.tick.dispatch")
    expect(body).toContain("- Next step: dispatch")
    expect(body).toContain("- Triggered by: local run")
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
      goal: { stage: "waiting", requiredEvidence: ["labelledTasksComplete"], missingEvidence: ["labelledTasksComplete"] },
      decision: { kind: "wait", reason: "waiting for labelled tasks" },
    })

    await commitGoalState(ctx, fakeProfile(), null)

    expect(putGoalStateMock).not.toHaveBeenCalled()
    expect(writeStateTextMock).toHaveBeenCalledOnce()
    const [, , path, body] = writeStateTextMock.mock.calls[0]!
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

    expect(writeStateTextMock).not.toHaveBeenCalled()
    expect(flushGoalRunLogEventsMock).toHaveBeenCalledOnce()
  })
})
