import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/goal/stateStore.js", () => ({
  fetchGoalState: vi.fn(),
  putGoalState: vi.fn(),
}))

import type { AgentResult } from "../../src/agent.js"
import { serializeGoalState, type GoalState } from "../../src/goal/state.js"
import { fetchGoalState, putGoalState } from "../../src/goal/stateStore.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { applyDutyReports } from "../../src/scripts/applyDutyReports.js"

const fetchGoalStateMock = vi.mocked(fetchGoalState)
const putGoalStateMock = vi.mocked(putGoalState)

function fakeCtx(data: Record<string, unknown>): Context {
  return {
    args: {},
    cwd: "/repo",
    config: {
      github: { owner: "o", repo: "r" },
      git: { defaultBranch: "main" },
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      agent: { model: "anthropic/claude-haiku-4-5-20251001" },
    },
    data,
    output: { exitCode: 0 },
  } as unknown as Context
}

function fakeProfile(): Profile {
  return { name: "release" } as Profile
}

function goalState(): GoalState {
  return {
    state: "active",
    extra: {
      type: "release",
      facts: { pendingEvidence: "releasePrExists" },
      blockers: [],
    },
  }
}

describe("applyDutyReports", () => {
  beforeEach(() => {
    fetchGoalStateMock.mockReset()
    putGoalStateMock.mockReset()
  })

  it("applies shell-collected goal reports to kody-state", async () => {
    const prior = goalState()
    fetchGoalStateMock.mockReturnValueOnce(prior)

    await applyDutyReports(
      fakeCtx({
        dutyReports: [
          {
            target: { type: "goal", id: "release-aguy" },
            evidence: { releasePrExists: true },
            facts: { releasePr: 123 },
          },
        ],
      }),
      fakeProfile(),
      null,
    )

    expect(fetchGoalStateMock).toHaveBeenCalledWith("o", "r", "release-aguy", "/repo")
    expect(putGoalStateMock).toHaveBeenCalledTimes(1)
    const [, , goalId, next] = putGoalStateMock.mock.calls[0]!
    expect(goalId).toBe("release-aguy")
    expect((next as GoalState).extra.facts).toMatchObject({
      releasePrExists: true,
      releasePr: 123,
    })
    expect(((next as GoalState).extra.facts as Record<string, unknown>).pendingEvidence).toBeUndefined()
  })

  it("also parses report markers from agent final text", async () => {
    fetchGoalStateMock.mockReturnValueOnce(goalState())
    const agentResult = {
      outcome: "completed",
      finalText:
        'DONE\nKODY_DUTY_REPORT={"target":{"type":"goal","id":"release-aguy"},"evidence":{"releasePrGreen":true}}',
    } as AgentResult

    await applyDutyReports(fakeCtx({}), fakeProfile(), agentResult)

    const [, , goalId, next] = putGoalStateMock.mock.calls[0]!
    expect(goalId).toBe("release-aguy")
    expect((next as GoalState).extra.facts).toMatchObject({ releasePrGreen: true })
  })

  it("skips no-op reports", async () => {
    const prior: GoalState = { state: "active", extra: { facts: { releasePrExists: true } } }
    fetchGoalStateMock.mockReturnValueOnce(prior)

    await applyDutyReports(
      fakeCtx({ dutyReports: [{ target: { type: "goal", id: "release-aguy" }, evidence: { releasePrExists: true } }] }),
      fakeProfile(),
      null,
    )

    expect(putGoalStateMock).not.toHaveBeenCalled()
    expect(serializeGoalState(prior)).toContain("releasePrExists")
  })
})
