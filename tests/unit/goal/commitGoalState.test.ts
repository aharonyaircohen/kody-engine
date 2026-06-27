import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
    readStateText: vi.fn(),
    upsertStateText: vi.fn(),
  }
})

import type { Context, Profile } from "../../../src/executables/types.js"
import { flushGoalRunLogEvents, stageGoalRunLogEvent } from "../../../src/goal/runLog.js"
import type { GoalState } from "../../../src/goal/state.js"
import { putGoalState } from "../../../src/goal/stateStore.js"
import { commitGoalState } from "../../../src/scripts/commitGoalState.js"
import type { GoalCtx } from "../../../src/scripts/goalCtx.js"
import { readStateText, upsertStateText } from "../../../src/stateRepo.js"

const putGoalStateMock = vi.mocked(putGoalState)
const flushGoalRunLogEventsMock = vi.mocked(flushGoalRunLogEvents)
const readStateTextMock = vi.mocked(readStateText)
const upsertStateTextMock = vi.mocked(upsertStateText)

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
  // When the runner hosts GHA env vars (GITHUB_EVENT_NAME=issue_comment here),
  // triggerContext() emits a GitHub-flavoured trigger and the report shows
  // "Triggered by: GitHub issue comment". The unit tests assert the opposite
  // shape ("Triggered by: local run"), so we scrub the vars for the duration of
  // the suite and restore them in afterEach.
  const githubEnvKeys = [
    "GITHUB_EVENT_NAME",
    "GITHUB_EVENT_PATH",
    "GITHUB_ACTOR",
    "GITHUB_ACTOR_ID",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_REPOSITORY",
    "GITHUB_SERVER_URL",
    "GITHUB_WORKFLOW",
    "GITHUB_JOB",
    "GITHUB_REF",
    "GITHUB_SHA",
  ] as const
  let savedGithubEnv: Record<string, string | undefined>

  beforeEach(() => {
    putGoalStateMock.mockReset()
    flushGoalRunLogEventsMock.mockReset()
    readStateTextMock.mockReset()
    upsertStateTextMock.mockReset()
    readStateTextMock.mockReturnValue(null)
    savedGithubEnv = {}
    for (const key of githubEnvKeys) {
      savedGithubEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of githubEnvKeys) {
      const value = savedGithubEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
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
    expect(upsertStateTextMock).toHaveBeenCalledOnce()
    expect(putGoalStateMock.mock.invocationCallOrder[0]).toBeLessThan(upsertStateTextMock.mock.invocationCallOrder[0]!)
    const [, , path, body] = upsertStateTextMock.mock.calls[0]!
    expect(path).toBe("reports/release-v1-2-3.md")
    expect(body).toContain("- Event: goal.tick.dispatch")
    expect(body).toContain("- Next step: dispatch")
    expect(body).toContain("- Triggered by: local run")
    expect(body).toContain("- Decided by: goal-manager")
    expect(body).toContain("- Dispatched by: goal-manager")
    expect(ctx.data.goalReports).toEqual([{ slug: "release-v1-2-3", path: "reports/release-v1-2-3.md", changed: true }])
    expect(flushGoalRunLogEventsMock).toHaveBeenCalledOnce()
  })

  it("refreshes the goal dashboard report for unchanged wait decisions", async () => {
    const raw = goalState()
    const ctx = fakeCtx(raw, { goalPersistChanged: false })
    stageGoalRunLogEvent(ctx.data, "release-v1-2-3", {
      source: "goal-manager",
      event: "goal.tick.wait",
      goalState: "active",
      stage: "prepare",
      status: "wait",
      reason: "waiting for evidence: releasePrExists",
      goal: { stage: "prepare", requiredEvidence: ["releasePrExists"], missingEvidence: ["releasePrExists"] },
      decision: { kind: "wait", reason: "waiting for evidence: releasePrExists" },
    })

    await commitGoalState(ctx, fakeProfile(), null)

    expect(putGoalStateMock).not.toHaveBeenCalled()
    expect(upsertStateTextMock).toHaveBeenCalledOnce()
    const [, , path, body] = upsertStateTextMock.mock.calls[0]!
    expect(path).toBe("reports/release-v1-2-3.md")
    expect(body).toContain("- Event: goal.tick.wait")
    expect(body).toContain("- Next step: wait")
    expect(body).toContain("- Reason: waiting for evidence: releasePrExists")
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

    expect(upsertStateTextMock).not.toHaveBeenCalled()
    expect(flushGoalRunLogEventsMock).toHaveBeenCalledOnce()
  })
})
