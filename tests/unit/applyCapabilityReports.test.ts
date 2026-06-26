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
vi.mock("../../src/stateRepo.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/stateRepo.js")>("../../src/stateRepo.js")
  return {
    ...actual,
    readStateText: vi.fn(),
    upsertStateText: vi.fn(),
  }
})

import type { AgentResult } from "../../src/agent.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { flushGoalRunLogEvents } from "../../src/goal/runLog.js"
import { type GoalState, serializeGoalState } from "../../src/goal/state.js"
import { fetchGoalState, putGoalState } from "../../src/goal/stateStore.js"
import { applyCapabilityReports } from "../../src/scripts/applyCapabilityReports.js"
import { readStateText, upsertStateText } from "../../src/stateRepo.js"

const fetchGoalStateMock = vi.mocked(fetchGoalState)
const putGoalStateMock = vi.mocked(putGoalState)
const flushGoalRunLogEventsMock = vi.mocked(flushGoalRunLogEvents)
const readStateTextMock = vi.mocked(readStateText)
const upsertStateTextMock = vi.mocked(upsertStateText)

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
      capabilities: ["release-prepare"],
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

describe("applyCapabilityReports", () => {
  beforeEach(() => {
    fetchGoalStateMock.mockReset()
    putGoalStateMock.mockReset()
    flushGoalRunLogEventsMock.mockReset()
    readStateTextMock.mockReset()
    upsertStateTextMock.mockReset()
    readStateTextMock.mockReturnValue(null)
  })

  it("applies shell-collected goal reports to kody-state", async () => {
    fetchGoalStateMock.mockReturnValueOnce(goalState())
    const data: Record<string, unknown> = {
      capabilityReports: [
        {
          target: { type: "goal", id: "release-aguy" },
          evidence: { releasePrExists: true },
          facts: { releasePr: 123 },
        },
      ],
    }

    await applyCapabilityReports(fakeCtx(data), fakeProfile(), null)

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
            capabilityOutput: expect.objectContaining({
              kind: "capability-evidence",
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
        'DONE\nKODY_CAPABILITY_REPORT={"target":{"type":"goal","id":"release-aguy"},"evidence":{"releasePrExists":true}}',
    } as AgentResult

    await applyCapabilityReports(fakeCtx({}), fakeProfile(), agentResult)

    const [, goalId, next] = putGoalStateMock.mock.calls[0]!
    expect(goalId).toBe("release-aguy")
    expect((next as GoalState).extra.facts).toMatchObject({ releasePrExists: true })
  })

  it("applies capability result pass to the pending agentGoal evidence", async () => {
    fetchGoalStateMock.mockReturnValueOnce(goalState())

    await applyCapabilityReports(
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
    expect((next as GoalState).extra.lastCapabilityResult).toBeUndefined()
  })

  it("merges report and result output before writing one goal evidence event", async () => {
    fetchGoalStateMock.mockReturnValueOnce(goalState())
    const data: Record<string, unknown> = {
      capabilityReports: [
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

    await applyCapabilityReports(
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
        capabilityOutput: {
          kind: "capability-evidence",
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

    await applyCapabilityReports(
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

  it("writes a goal-owned dashboard report when saveReport is requested", async () => {
    fetchGoalStateMock.mockReturnValueOnce(goalState())
    const data: Record<string, unknown> = {
      jobSaveReport: true,
      dutyResults: [
        {
          version: 1,
          status: "pass",
          summary: "Release PR exists.",
          facts: { releasePr: 123 },
          artifacts: [{ label: "PR", url: "https://github.com/o/r/pull/123" }],
          missingEvidence: [],
          blockers: [],
        },
      ],
    }

    await applyCapabilityReports(
      fakeCtx(data, { goal: "release-aguy", evidence: "releasePrExists" }),
      fakeProfile(),
      null,
    )

    expect(upsertStateTextMock).toHaveBeenCalledOnce()
    const [, , path, body, message] = upsertStateTextMock.mock.calls[0]!
    expect(path).toBe("reports/release-aguy.md")
    expect(message).toBe("chore(reports): refresh release-aguy")
    expect(body).toContain("# release-aguy")
    expect(body).toContain("- Next step: done")
    expect(body).toContain("- Summary: Release PR exists.")
    expect(body).toContain('"releasePr": 123')
    expect(body).toContain("[PR](https://github.com/o/r/pull/123)")
    expect(data.goalReports).toEqual([{ slug: "release-aguy", path: "reports/release-aguy.md", changed: true }])
    expect(putGoalStateMock.mock.invocationCallOrder[0]).toBeLessThan(upsertStateTextMock.mock.invocationCallOrder[0]!)
  })

  it("does not write a dashboard report when goal state persistence fails", async () => {
    fetchGoalStateMock.mockReturnValueOnce(goalState())
    putGoalStateMock.mockImplementationOnce(() => {
      throw new Error("state write failed")
    })

    await expect(
      applyCapabilityReports(
        fakeCtx(
          {
            jobSaveReport: true,
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
          { goal: "release-aguy", evidence: "releasePrExists" },
        ),
        fakeProfile(),
        null,
      ),
    ).rejects.toThrow("state write failed")

    expect(upsertStateTextMock).not.toHaveBeenCalled()
    expect(flushGoalRunLogEventsMock).toHaveBeenCalledOnce()
  })

  it("does not write a dashboard report unless saveReport is requested", async () => {
    fetchGoalStateMock.mockReturnValueOnce(goalState())

    await applyCapabilityReports(
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
        { goal: "release-aguy", evidence: "releasePrExists" },
      ),
      fakeProfile(),
      null,
    )

    expect(upsertStateTextMock).not.toHaveBeenCalled()
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
        capabilities: ["release-prepare", "release-merge", "vercel-production-deploy"],
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

    await applyCapabilityReports(
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

  it("applies capability result failure as agentGoal evidence false plus blocker", async () => {
    fetchGoalStateMock.mockReturnValueOnce(goalState())

    await applyCapabilityReports(
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
      capabilityReports: [
        { target: { type: "goal", id: "release-aguy" }, evidence: { releasePrExists: true } },
      ],
    }

    await applyCapabilityReports(fakeCtx(data), fakeProfile(), null)

    expect(putGoalStateMock).not.toHaveBeenCalled()
    expect(stagedGoalEvents(data, "release-aguy")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "goal.evidence.unchanged",
          inspection: expect.objectContaining({
            capabilityOutput: expect.objectContaining({
              kind: "capability-evidence",
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
