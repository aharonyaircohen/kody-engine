import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/stateRepo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/stateRepo.js")>()),
  appendStateLine: vi.fn(),
}))

vi.mock("../../../src/runIndex.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/runIndex.js")>()),
  upsertRunIndexRowBestEffort: vi.fn(),
}))

import {
  flushGoalRunLogEvents,
  goalRunLogChange,
  goalRunLogSnapshot,
  stageGoalRunLogEvent,
} from "../../../src/goal/runLog.js"
import { upsertRunIndexRowBestEffort } from "../../../src/runIndex.js"
import { appendStateLine } from "../../../src/stateRepo.js"

const appendStateLineMock = vi.mocked(appendStateLine)
const upsertRunIndexRowBestEffortMock = vi.mocked(upsertRunIndexRowBestEffort)

const config = {
  quality: { typecheck: "", lint: "", testUnit: "", format: "" },
  git: { defaultBranch: "main" },
  github: { owner: "o", repo: "r" },
  agent: { model: "anthropic/claude-haiku-4-5-20251001" },
  state: { repo: "o/kody-state", path: "r" },
}

describe("goal run logs", () => {
  beforeEach(() => {
    appendStateLineMock.mockReset()
    upsertRunIndexRowBestEffortMock.mockReset()
  })

  afterEach(() => {
    delete process.env.GITHUB_RUN_ID
    delete process.env.GITHUB_RUN_ATTEMPT
    delete process.env.GITHUB_REPOSITORY
    delete process.env.GITHUB_SERVER_URL
    delete process.env.GITHUB_WORKFLOW
    delete process.env.GITHUB_JOB
    delete process.env.GITHUB_EVENT_NAME
    delete process.env.GITHUB_ACTOR
    delete process.env.GITHUB_EVENT_PATH
  })

  it("writes staged goal events as JSONL under the state repo path", () => {
    process.env.GITHUB_RUN_ID = "123"
    process.env.GITHUB_RUN_ATTEMPT = "2"
    process.env.GITHUB_REPOSITORY = "o/r"
    process.env.GITHUB_SERVER_URL = "https://github.com"
    process.env.GITHUB_WORKFLOW = "kody"
    process.env.GITHUB_JOB = "run"
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
    process.env.GITHUB_ACTOR = "alice"
    const data: Record<string, unknown> = {
      jobId: "job 1",
      jobKey: "goal-manager:weekly",
      jobFlavor: "instant",
      jobCapability: "goal-manager",
      jobExecutable: "goal-manager",
      jobWhy: "manual live audit test",
    }

    stageGoalRunLogEvent(
      data,
      "web-release",
      {
        source: "goal-manager",
        event: "goal.tick.dispatch",
        goalType: "web-release",
        status: "dispatch",
        decision: {
          kind: "dispatch",
          evidence: "releasePrExists",
        },
        evidence: "releasePrExists",
        dispatch: {
          capability: "release-prepare",
          executable: "release-prepare",
          cliArgs: { goal: "web-release" },
        },
      },
      "2026-06-25T10:00:00Z",
    )

    flushGoalRunLogEvents(config, "/repo", data)

    expect(appendStateLineMock).toHaveBeenCalledOnce()
    const [, cwd, filePath, line, message] = appendStateLineMock.mock.calls[0]!
    expect(cwd).toBe("/repo")
    expect(filePath).toMatch(/^logs\/goals\/web-release\/runs\/.+-job-1\.jsonl$/)
    expect(message).toBe("chore(goal-logs): append web-release")

    const event = JSON.parse((line as string).trim()) as Record<string, unknown>
    expect(event).toMatchObject({
      version: 1,
      time: "2026-06-25T10:00:00Z",
      source: "goal-manager",
      event: "goal.tick.dispatch",
      goalId: "web-release",
      goalType: "web-release",
      evidence: "releasePrExists",
      status: "dispatch",
      run: {
        provider: "github-actions",
        githubRunId: "123",
        githubRunAttempt: "2",
        workflow: "kody",
        job: "run",
        url: "https://github.com/o/r/actions/runs/123",
      },
      repo: {
        owner: "o",
        repo: "r",
        fullName: "o/r",
      },
      stateRepo: {
        repo: "o/kody-state",
        path: "r",
        branch: "main",
        goalStatePath: "r/todos/web-release.json",
      },
      trigger: {
        source: "github-actions",
        kind: "manual-workflow-dispatch",
        eventName: "workflow_dispatch",
        actor: "alice",
        githubActor: "alice",
        actorRole: "manual workflow dispatcher",
      },
      dispatchContext: {
        triggeredBy: "manual workflow dispatch",
        triggerKind: "manual-workflow-dispatch",
        dispatchMode: "manual",
        githubActor: "alice",
        githubActorRole: "manual workflow dispatcher",
        decidedBy: "goal-manager",
        dispatchedBy: "goal-manager",
        capability: "release-prepare",
      },
      job: {
        id: "job 1",
        key: "goal-manager:weekly",
        flavor: "instant",
        capability: "goal-manager",
        executable: "goal-manager",
        why: "manual live audit test",
      },
      links: {
        workflowRun: "https://github.com/o/r/actions/runs/123",
        goalState: "https://github.com/o/kody-state/blob/main/r/todos/web-release.json",
      },
      decision: {
        kind: "dispatch",
        evidence: "releasePrExists",
      },
    })
    expect((event.stateRepo as Record<string, unknown>).logPath).toMatch(
      /^r\/logs\/goals\/web-release\/runs\/.+-job-1\.jsonl$/,
    )
    expect((event.links as Record<string, unknown>).log).toMatch(
      /^https:\/\/github\.com\/o\/kody-state\/blob\/main\/r\/logs\/goals\/web-release\/runs\/.+-job-1\.jsonl$/,
    )
    expect(upsertRunIndexRowBestEffortMock).toHaveBeenCalledWith(
      config,
      "/repo",
      expect.objectContaining({
        subjectType: "goal",
        subjectId: "web-release",
        sourceType: "goal-run-log",
      }),
    )
  })

  it("separates a scheduled workflow actor from the actual goal dispatcher", () => {
    const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-run-log-"))
    const eventPath = path.join(eventDir, "event.json")
    fs.writeFileSync(eventPath, JSON.stringify({ schedule: "*/15 * * * *" }))
    process.env.GITHUB_RUN_ID = "456"
    process.env.GITHUB_RUN_ATTEMPT = "1"
    process.env.GITHUB_REPOSITORY = "o/r"
    process.env.GITHUB_WORKFLOW = "kody"
    process.env.GITHUB_JOB = "run"
    process.env.GITHUB_EVENT_NAME = "schedule"
    process.env.GITHUB_ACTOR = "aguyaharonyair"
    process.env.GITHUB_EVENT_PATH = eventPath
    const data: Record<string, unknown> = {
      jobId: "gh-456-1",
      jobKey: "instant:goal-manager",
      jobFlavor: "instant",
      jobAction: "goal-manager",
      jobCapability: "goal-manager",
      jobExecutable: "goal-manager",
    }

    stageGoalRunLogEvent(
      data,
      "daily-web-release-loop",
      {
        source: "goal-manager",
        event: "loop.tick.dispatch",
        goalType: "agentLoop",
        status: "dispatch",
        reason: "dispatch goal web-release",
        target: { type: "goal", id: "web-release" },
        dispatch: {
          action: "goal-manager",
          executable: "goal-manager",
          cliArgs: { goal: "web-release" },
        },
      },
      "2026-06-26T15:21:27Z",
    )

    flushGoalRunLogEvents(config, "/repo", data)

    const line = appendStateLineMock.mock.calls[0]![3] as string
    const event = JSON.parse(line.trim()) as Record<string, unknown>
    expect(event).toMatchObject({
      trigger: {
        source: "github-actions",
        kind: "schedule",
        eventName: "schedule",
        actor: "aguyaharonyair",
        githubActor: "aguyaharonyair",
        actorRole: "github workflow run actor; not the manual dispatcher",
        schedule: "*/15 * * * *",
      },
      dispatchContext: {
        triggeredBy: "GitHub schedule",
        triggerKind: "schedule",
        dispatchMode: "automated",
        githubActor: "aguyaharonyair",
        githubActorRole: "github workflow run actor; not the manual dispatcher",
        decidedBy: "goal-manager",
        dispatchedBy: "goal-manager",
        target: { type: "goal", id: "web-release" },
        action: "goal-manager",
        reason: "dispatch goal web-release",
      },
    })
  })

  it("summarizes goal snapshots and changes for audit readers", () => {
    const before = goalRunLogSnapshot("release", "active", {
      type: "release",
      destination: { outcome: "ship prod", evidence: ["releasePrExists", "productionDeployed"] },
      capabilities: ["release-prepare"],
      route: [
        {
          evidence: "releasePrExists",
          stage: "prepare",
          capability: "release-prepare",
          executable: "release-prepare",
          args: { goal: "release" },
        },
      ],
      stage: "prepare",
      facts: { releasePrExists: true, pendingEvidence: "productionDeployed" },
      blockers: [],
    })
    const after = goalRunLogSnapshot("release", "done", {
      type: "release",
      destination: { outcome: "ship prod", evidence: ["releasePrExists", "productionDeployed"] },
      capabilities: ["release-prepare"],
      route: [],
      stage: "done",
      facts: { releasePrExists: true, productionDeployed: true },
      blockers: [],
    })

    expect(before).toMatchObject({
      id: "release",
      type: "release",
      state: "active",
      stage: "prepare",
      requiredEvidence: ["releasePrExists", "productionDeployed"],
      satisfiedEvidence: ["releasePrExists"],
      missingEvidence: ["productionDeployed"],
      pendingEvidence: "productionDeployed",
    })
    expect(goalRunLogChange(before, after)).toMatchObject({
      state: { from: "active", to: "done" },
      stage: { from: "prepare", to: "done" },
      pendingEvidence: { from: "productionDeployed" },
      facts: {
        added: ["productionDeployed"],
        removed: ["pendingEvidence"],
        changed: [],
      },
      satisfiedEvidence: {
        added: ["productionDeployed"],
        removed: [],
      },
    })
  })
})
