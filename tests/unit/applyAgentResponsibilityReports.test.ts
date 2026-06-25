import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/goal/stateStore.js", () => ({
  fetchGoalState: vi.fn(),
  putGoalState: vi.fn(),
}))
vi.mock("../../src/goal/runLog.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/goal/runLog.js")>("../../src/goal/runLog.js")
  return {
    ...actual,
    flushGoalRunLogEvents: vi.fn(),
  }
})

import type { AgentResult } from "../../src/agent.js"
import type { Context, Profile } from "../../src/agent-actions/types.js"
import { flushGoalRunLogEvents } from "../../src/goal/runLog.js"
import { type GoalState, serializeGoalState } from "../../src/goal/state.js"
import { fetchGoalState, putGoalState } from "../../src/goal/stateStore.js"
import { applyAgentResponsibilityReports } from "../../src/scripts/applyAgentResponsibilityReports.js"

const fetchGoalStateMock = vi.mocked(fetchGoalState)
const putGoalStateMock = vi.mocked(putGoalState)
const flushGoalRunLogEventsMock = vi.mocked(flushGoalRunLogEvents)

function fakeCtx(data: Record<string, unknown>, args: Record<string, unknown> = {}): Context {
  return {
    args,
    cwd: "/repo",
    config: {
      github: { owner: "o", repo: "r" },
      state: { repo: "o/kody-state", path: "r" },
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
      destination: { outcome: "release is prepared", evidence: ["releasePrExists"] },
      agentResponsibilities: ["release-prepare"],
      route: [],
      stage: "prepare",
      facts: { pendingEvidence: "releasePrExists" },
      blockers: [],
    },
  }
}

function stagedGoalEvents(data: Record<string, unknown>, goalId: string): Array<Record<string, unknown>> {
  const logs = data.__goalRunLogs as Record<string, { events: Array<Record<string, unknown>> }> | undefined
  return logs?.[goalId]?.events ?? []
}

describe("applyAgentResponsibilityReports", () => {
  beforeEach(() => {
    fetchGoalStateMock.mockReset()
    putGoalStateMock.mockReset()
    flushGoalRunLogEventsMock.mockReset()
  })

  it("applies shell-collected goal reports to kody-state", async () => {
    fetchGoalStateMock.mockReturnValueOnce(goalState())
    const data = {
      agentResponsibilityReports: [
        {
          target: { type: "goal", id: "release-aguy" },
          evidence: { releasePrExists: true },
          facts: { releasePr: 123 },
        },
      ],
    }

    await applyAgentResponsibilityReports(fakeCtx(data), fakeProfile(), null)

    const [, goalId, next] = putGoalStateMock.mock.calls[0]!
    expect(goalId).toBe("release-aguy")
    expect((next as GoalState).extra.facts).toEqual({ releasePrExists: true, releasePr: 123 })
    expect(flushGoalRunLogEventsMock).toHaveBeenCalledOnce()
    expect(stagedGoalEvents(data, "release-aguy")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "goal-loop",
          event: "goal.evidence.applied",
          inspection: expect.objectContaining({
            responsibilityOutput: expect.objectContaining({
              kind: "responsibility-evidence",
              sources: ["report"],
              status: "changed",
              evidence: { releasePrExists: true },
              facts: { releasePr: 123 },
              artifacts: [],
              missingEvidence: [],
              blockers: [],
            }),
          }),
          decision: expect.objectContaining({
            kind: "accept-evidence",
            nextStep: "done",
          }),
        }),
      ]),
    )
  })

  it("applies agent-emitted goal reports", async () => {
    fetchGoalStateMock.mockReturnValueOnce(goalState())
    const agentResult = {
      outcome: "completed",
      finalText:
        'DONE\nKODY_AGENT_RESPONSIBILITY_REPORT={"target":{"type":"goal","id":"release-aguy"},"evidence":{"releasePrExists":true}}',
    } as AgentResult

    await applyAgentResponsibilityReports(fakeCtx({}), fakeProfile(), agentResult)

    const [, goalId, next] = putGoalStateMock.mock.calls[0]!
    expect(goalId).toBe("release-aguy")
    expect((next as GoalState).extra.facts).toMatchObject({ releasePrExists: true })
  })

  it("applies agentResponsibility result pass to the pending agentGoal evidence", async () => {
    fetchGoalStateMock.mockReturnValueOnce(goalState())

    await applyAgentResponsibilityReports(
      fakeCtx(
        {
          dutyResults: [
            {
              version: 1,
              status: "pass",
              summary: "Release PR exists.",
              facts: { releasePr: 123 },
              artifacts: [],
              missingEvidence: [],
              blockers: [],
            },
          ],
        },
        { goal: "release-aguy" },
      ),
      fakeProfile(),
      null,
    )

    const [, goalId, next] = putGoalStateMock.mock.calls[0]!
    expect(goalId).toBe("release-aguy")
    expect((next as GoalState).extra.facts).toEqual({ releasePrExists: true, releasePr: 123 })
    expect((next as GoalState).extra.lastAgentResponsibilityResult).toBeUndefined()
  })

  it("merges report and result output before writing one goal evidence event", async () => {
    fetchGoalStateMock.mockReturnValueOnce(goalState())
    const data = {
      agentResponsibilityReports: [
        {
          target: { type: "goal", id: "release-aguy" },
          evidence: { releasePrExists: true },
          facts: { releasePr: 123 },
        },
      ],
      dutyResults: [
        {
          version: 1,
          status: "pass",
          summary: "Release PR exists.",
          facts: { headSha: "abc123" },
          artifacts: [{ label: "PR", url: "https://github.com/o/r/pull/123" }],
          missingEvidence: [],
          blockers: [],
        },
      ],
    }

    await applyAgentResponsibilityReports(
      fakeCtx(data, { goal: "release-aguy", evidence: "releasePrExists" }),
      fakeProfile(),
      null,
    )

    const [, , next] = putGoalStateMock.mock.calls[0]!
    expect((next as GoalState).extra.facts).toEqual({
      releasePrExists: true,
      releasePr: 123,
      headSha: "abc123",
    })
    const evidenceEvents = stagedGoalEvents(data, "release-aguy").filter(
      (event) => event.event === "goal.evidence.applied",
    )
    expect(evidenceEvents).toHaveLength(1)
    expect(evidenceEvents[0]).toMatchObject({
      source: "goal-loop",
      status: "pass",
      reason: "Release PR exists.",
      evidence: "releasePrExists",
      evidenceValues: { releasePrExists: true },
      facts: { releasePr: 123, headSha: "abc123" },
      artifacts: [{ label: "PR", url: "https://github.com/o/r/pull/123" }],
      inspection: {
        responsibilityOutput: {
          kind: "responsibility-evidence",
          sources: ["report", "result"],
          status: "pass",
          summary: "Release PR exists.",
        },
      },
    })
  })

  it("does not apply legacy --evidence when a result declares its own evidence", async () => {
    fetchGoalStateMock.mockReturnValueOnce(goalState())
    const data = {
      dutyResults: [
        {
          version: 1,
          target: { type: "goal", id: "release-aguy" },
          status: "pass",
          summary: "Production deployed.",
          evidence: { productionDeployed: true },
          facts: {},
          artifacts: [],
          missingEvidence: [],
          blockers: [],
        },
      ],
    }

    await applyAgentResponsibilityReports(
      fakeCtx(data, { goal: "release-aguy", evidence: "releasePrExists" }),
      fakeProfile(),
      null,
    )

    const [, , next] = putGoalStateMock.mock.calls[0]!
    expect((next as GoalState).extra.facts).toEqual({
      pendingEvidence: "releasePrExists",
      productionDeployed: true,
    })
    expect(stagedGoalEvents(data, "release-aguy")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "goal.evidence.applied",
          evidence: undefined,
          evidenceValues: { productionDeployed: true },
          decision: expect.objectContaining({
            evidence: undefined,
            evidenceValues: { productionDeployed: true },
          }),
        }),
      ]),
    )
  })

  it("marks managed goal done when result satisfies final destination evidence", async () => {
    fetchGoalStateMock.mockReturnValueOnce({
      state: "active",
      extra: {
        type: "web-release",
        destination: {
          outcome: "Release is prepared, merged main, and deployed production.",
          evidence: ["releasePrExists", "mainMerged", "productionDeployed"],
        },
        agentResponsibilities: ["release-prepare", "release-merge", "vercel-production-deploy"],
        route: [],
        stage: "publish",
        facts: {
          releasePrExists: true,
          mainMerged: true,
          pendingEvidence: "productionDeployed",
        },
        blockers: [],
      },
    })

    await applyAgentResponsibilityReports(
      fakeCtx(
        {
          dutyResults: [
            {
              version: 1,
              status: "pass",
              summary: "Production deployed.",
              facts: { productionDeploymentUrl: "https://example.com" },
              artifacts: [],
              missingEvidence: [],
              blockers: [],
            },
          ],
        },
        { goal: "release-aguy", evidence: "productionDeployed" },
      ),
      fakeProfile(),
      null,
    )

    const [, , next] = putGoalStateMock.mock.calls[0]!
    expect((next as GoalState).state).toBe("done")
    expect((next as GoalState).extra.stage).toBe("done")
    expect((next as GoalState).extra.facts).toEqual({
      releasePrExists: true,
      mainMerged: true,
      productionDeployed: true,
      productionDeploymentUrl: "https://example.com",
    })
  })

  it("applies agentResponsibility result failure as agentGoal evidence false plus blocker", async () => {
    fetchGoalStateMock.mockReturnValueOnce(goalState())

    await applyAgentResponsibilityReports(
      fakeCtx(
        {
          dutyResults: [
            {
              version: 1,
              status: "fail",
              summary: "Release PR failed validation.",
              facts: { reason: "ci" },
              artifacts: [],
              missingEvidence: ["releasePrExists"],
              blockers: ["CI is red."],
            },
          ],
        },
        { goal: "release-aguy", evidence: "releasePrExists" },
      ),
      fakeProfile(),
      null,
    )

    const [, , next] = putGoalStateMock.mock.calls[0]!
    expect((next as GoalState).extra.facts).toEqual({ releasePrExists: false, reason: "ci" })
    expect((next as GoalState).extra.blockers).toEqual(["CI is red."])
  })

  it("logs no-op reports without persisting unchanged goal state", async () => {
    const prior: GoalState = { state: "active", extra: { facts: { releasePrExists: true } } }
    fetchGoalStateMock.mockReturnValueOnce(prior)
    const data = {
      agentResponsibilityReports: [
        { target: { type: "goal", id: "release-aguy" }, evidence: { releasePrExists: true } },
      ],
    }

    await applyAgentResponsibilityReports(fakeCtx(data), fakeProfile(), null)

    expect(putGoalStateMock).not.toHaveBeenCalled()
    expect(stagedGoalEvents(data, "release-aguy")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "goal.evidence.unchanged",
          inspection: expect.objectContaining({
            responsibilityOutput: expect.objectContaining({
              kind: "responsibility-evidence",
              sources: ["report"],
            }),
          }),
          decision: expect.objectContaining({ kind: "no-state-change" }),
        }),
      ]),
    )
    expect(serializeGoalState(prior)).toContain("releasePrExists")
  })
})
