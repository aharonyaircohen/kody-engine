import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/stateRepo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/stateRepo.js")>()),
  appendStateLine: vi.fn(),
}))

import {
  flushGoalRunLogEvents,
  goalRunLogChange,
  goalRunLogSnapshot,
  stageGoalRunLogEvent,
} from "../../../src/goal/runLog.js"
import { appendStateLine } from "../../../src/stateRepo.js"

const appendStateLineMock = vi.mocked(appendStateLine)

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
        goalStatePath: "r/goals/instances/web-release/state.json",
      },
      trigger: {
        eventName: "workflow_dispatch",
        actor: "alice",
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
        goalState: "https://github.com/o/kody-state/blob/main/r/goals/instances/web-release/state.json",
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
