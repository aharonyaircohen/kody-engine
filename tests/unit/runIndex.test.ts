import { beforeEach, describe, expect, it, vi } from "vitest"

const stateRepo = vi.hoisted(() => ({
  readStateText: vi.fn(),
  writeStateText: vi.fn(),
}))

vi.mock("../../src/stateRepo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/stateRepo.js")>()),
  readStateText: stateRepo.readStateText,
  writeStateText: stateRepo.writeStateText,
}))

import {
  finalizeStagedRunIndexRows,
  mergeRunIndexRow,
  runIndexPath,
  runIndexRowFromGoalEvents,
  runIndexRowFromJobContext,
  stageRunIndexFinalization,
  statusFromExitCode,
  upsertRunIndexRow,
} from "../../src/runIndex.js"

const config = {
  github: { owner: "o", repo: "r" },
  state: { repo: "o/kody-state", path: "r" },
}

describe("run index", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.GITHUB_RUN_ID
    delete process.env.GITHUB_RUN_ATTEMPT
    delete process.env.GITHUB_REPOSITORY
    delete process.env.GITHUB_SERVER_URL
    delete process.env.GITHUB_EVENT_NAME
    delete process.env.GITHUB_ACTOR
  })

  it("keeps a compact newest-first projection by run id", () => {
    const first = mergeRunIndexRow(null, {
      version: 1,
      id: "workflow:ship:run-1",
      subjectType: "workflow",
      subjectId: "ship",
      status: "running",
      title: "Ship",
      updatedAt: "2026-07-05T10:00:00.000Z",
    })

    const second = mergeRunIndexRow(JSON.stringify(first), {
      version: 1,
      id: "workflow:ship:run-1",
      subjectType: "workflow",
      subjectId: "ship",
      status: "success",
      title: "Ship",
      updatedAt: "2026-07-05T10:02:00.000Z",
    })

    expect(second.runs).toHaveLength(1)
    expect(second.runs[0]).toMatchObject({
      id: "workflow:ship:run-1",
      status: "success",
      updatedAt: "2026-07-05T10:02:00.000Z",
    })
  })

  it("preserves legacy dispatch rows as open work instead of normalizing them to success", () => {
    const next = mergeRunIndexRow(
      JSON.stringify({
        version: 1,
        updatedAt: "2026-07-05T10:00:00.000Z",
        runs: [
          {
            version: 1,
            id: "goal:ci-health:run-0",
            subjectType: "goal",
            subjectId: "ci-health",
            status: "running",
            title: "ci-health",
            summary: "dispatch dev-ci-health: ready for loop tick",
            currentStep: "watching",
            updatedAt: "2026-07-05T10:00:00.000Z",
          },
          {
            version: 1,
            id: "goal:ci-health:run-2",
            subjectType: "goal",
            subjectId: "ci-health",
            status: "waiting",
            title: "ci-health",
            decision: "dispatch - dispatch dev-ci-health: ready for loop tick",
            currentStep: "watching",
            updatedAt: "2026-07-05T10:30:00.000Z",
          },
        ],
      }),
      {
        version: 1,
        id: "goal:release:run-1",
        subjectType: "goal",
        subjectId: "release",
        status: "success",
        title: "release",
        updatedAt: "2026-07-05T11:00:00.000Z",
      },
    )

    expect(next.runs[1]).toMatchObject({
      id: "goal:ci-health:run-0",
      status: "running",
    })
    expect(next.runs[2]).toMatchObject({
      id: "goal:ci-health:run-2",
      status: "waiting",
    })
  })

  it("finalizes staged goal rows from the actual engine result", () => {
    const row = {
      version: 1 as const,
      id: "goal:ci-health:run-0",
      subjectType: "goal" as const,
      subjectId: "ci-health",
      status: "running" as const,
      title: "ci-health",
      summary: "dispatch dev-ci-health: ready for loop tick",
      updatedAt: "2026-07-05T10:00:00.000Z",
    }
    const data: Record<string, unknown> = {}
    stageRunIndexFinalization(data, row)
    stateRepo.readStateText.mockReturnValue({
      content: JSON.stringify({ version: 1, updatedAt: row.updatedAt, runs: [row] }),
      sha: "sha-1",
    })

    finalizeStagedRunIndexRows(config, "/repo", data, {
      status: "failed",
      updatedAt: "2026-07-05T10:05:00.000Z",
      reason: "dev-ci-health failed",
    })

    const [, , filePath, content] = stateRepo.writeStateText.mock.calls[0]!
    expect(filePath).toBe(runIndexPath())
    expect(JSON.parse(String(content)).runs[0]).toMatchObject({
      id: "goal:ci-health:run-0",
      status: "failed",
      summary: "dev-ci-health failed",
      updatedAt: "2026-07-05T10:05:00.000Z",
    })
  })

  it("keeps loop dispatch rows waiting on the child goal after dispatch succeeds", () => {
    const row = {
      version: 1 as const,
      id: "loop:daily-web-release-loop:gh-123-1-1",
      subjectType: "loop" as const,
      subjectId: "daily-web-release-loop",
      subjectModel: "agentLoop",
      status: "running" as const,
      title: "daily-web-release-loop",
      summary: "dispatch goal web-release-2026-07-06",
      currentStep: "loop.tick.dispatch",
      target: { type: "goal", id: "web-release-2026-07-06" },
      sourceType: "goal-run-log" as const,
      updatedAt: "2026-07-06T11:45:45.000Z",
    }
    const data: Record<string, unknown> = {}
    stageRunIndexFinalization(data, row)
    stateRepo.readStateText.mockReturnValue({
      content: JSON.stringify({ version: 1, updatedAt: row.updatedAt, runs: [row] }),
      sha: "sha-1",
    })

    finalizeStagedRunIndexRows(config, "/repo", data, {
      status: "success",
      updatedAt: "2026-07-06T11:45:46.000Z",
      reason: "dispatch goal web-release-2026-07-06",
    })

    const [, , filePath, content] = stateRepo.writeStateText.mock.calls[0]!
    expect(filePath).toBe(runIndexPath())
    expect(JSON.parse(String(content)).runs[0]).toMatchObject({
      id: "loop:daily-web-release-loop:gh-123-1-1",
      status: "waiting",
      summary: "waiting on goal web-release-2026-07-06",
      currentStep: "web-release-2026-07-06",
    })
  })

  it("writes runs/index.json with conflict retry", () => {
    stateRepo.readStateText
      .mockReturnValueOnce({
        content: JSON.stringify({ version: 1, updatedAt: "old", runs: [] }),
        sha: "sha-1",
      })
      .mockReturnValueOnce({
        content: JSON.stringify({
          version: 1,
          updatedAt: "other",
          runs: [
            {
              version: 1,
              id: "goal:release:run-0",
              subjectType: "goal",
              subjectId: "release",
              status: "success",
              title: "release",
              updatedAt: "2026-07-05T09:00:00.000Z",
            },
          ],
        }),
        sha: "sha-2",
      })
    stateRepo.writeStateText.mockImplementationOnce(() => {
      throw new Error("HTTP 409 Conflict")
    })

    upsertRunIndexRow(config, "/repo", {
      version: 1,
      id: "workflow:ship:run-1",
      subjectType: "workflow",
      subjectId: "ship",
      status: "running",
      title: "Ship",
      updatedAt: "2026-07-05T10:00:00.000Z",
    })

    expect(stateRepo.writeStateText).toHaveBeenCalledTimes(2)
    const [, , filePath, content, message, sha] = stateRepo.writeStateText.mock.calls[1]!
    expect(filePath).toBe(runIndexPath())
    expect(message).toBe("chore(runs): update run index")
    expect(sha).toBe("sha-2")
    expect(JSON.parse(String(content)).runs.map((run: { id: string }) => run.id)).toEqual([
      "workflow:ship:run-1",
      "goal:release:run-0",
    ])
  })

  it("builds workflow rows from runtime job context including model", () => {
    process.env.GITHUB_RUN_ID = "123"
    process.env.GITHUB_RUN_ATTEMPT = "2"
    process.env.GITHUB_REPOSITORY = "o/r"
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
    process.env.GITHUB_ACTOR = "alice"

    const row = runIndexRowFromJobContext({
      profileName: "release-prepare",
      profile: { name: "release-prepare", describe: "Prepare release.", agent: "release" },
      status: statusFromExitCode(0),
      startedAt: "2026-07-05T10:00:00.000Z",
      updatedAt: "2026-07-05T10:01:00.000Z",
      data: {
        runSubjectType: "workflow",
        runSubjectId: "web-release",
        runSubjectLabel: "Web release",
        workflowStep: "prepare",
        jobId: "job-1",
        jobFlavor: "instant",
        jobCapability: "release-prepare",
        jobExecutable: "release-prepare",
        jobModel: "claude/claude-haiku-4-5-20251001",
        jobModelProvider: "claude",
        jobModelName: "claude-haiku-4-5-20251001",
      },
    })

    expect(row).toMatchObject({
      id: "workflow:web-release:job-1",
      subjectType: "workflow",
      subjectId: "web-release",
      status: "success",
      currentStep: "prepare",
      model: "claude/claude-haiku-4-5-20251001",
      modelProvider: "claude",
      modelName: "claude-haiku-4-5-20251001",
      githubRunUrl: "https://github.com/o/r/actions/runs/123",
      triggerMode: "manual",
      actor: "alice",
    })
  })

  it("marks dispatch rows as running until the engine finalizes them", () => {
    const row = runIndexRowFromGoalEvents("ci-health", "logs/goals/ci-health/runs/run.jsonl", [
      {
        time: "2026-07-05T10:00:00.000Z",
        goalId: "ci-health",
        goalType: "agentLoop",
        event: "loop.tick.dispatch",
        status: "dispatch",
        run: { id: "gh-123-1", githubRunId: "123", githubRunAttempt: "1" },
        trigger: { kind: "schedule", githubActor: "github-actions" },
        job: {
          id: "gh-123-1",
          capability: "goal-manager",
          executable: "goal-manager",
          model: "claude/claude-haiku-4-5-20251001",
        },
        links: {
          workflowRun: "https://github.com/o/r/actions/runs/123",
          log: "https://github.com/o/kody-state/blob/main/r/logs/goals/ci-health/runs/run.jsonl",
        },
        stateRepo: { goalStatePath: "r/todos/ci-health.json" },
      },
    ])

    expect(row).toMatchObject({
      id: "loop:ci-health:gh-123-1",
      subjectType: "loop",
      subjectModel: "agentLoop",
      status: "running",
      sourceType: "goal-run-log",
      sourcePath: "logs/goals/ci-health/runs/run.jsonl",
      detailUrl: "https://github.com/o/kody-state/blob/main/r/logs/goals/ci-health/runs/run.jsonl",
      model: "claude/claude-haiku-4-5-20251001",
      triggerMode: "scheduled",
    })
  })

  it("marks idle loop rows as waiting instead of success", () => {
    const row = runIndexRowFromGoalEvents("daily-web-release-loop", "logs/goals/daily-web-release-loop/runs/run.jsonl", [
      {
        time: "2026-07-06T11:30:07.000Z",
        goalId: "daily-web-release-loop",
        goalType: "agentLoop",
        event: "loop.tick.idle",
        status: "idle",
        reason: "already dispatched today at preferred time 02:00 Asia/Jerusalem",
        decision: {
          kind: "idle",
          reason: "already dispatched today at preferred time 02:00 Asia/Jerusalem",
        },
        run: { id: "gh-28788241519-1-1", githubRunId: "28788241519", githubRunAttempt: "1" },
        trigger: { kind: "manual-workflow-dispatch", githubActor: "aguyaharonyair" },
        job: {
          id: "gh-28788241519-1-1",
          action: "goal-manager",
          capability: "goal-manager",
          executable: "goal-manager",
        },
      },
    ])

    expect(row).toMatchObject({
      id: "loop:daily-web-release-loop:gh-28788241519-1-1",
      subjectType: "loop",
      status: "waiting",
      summary: "already dispatched today at preferred time 02:00 Asia/Jerusalem",
    })
  })
})
