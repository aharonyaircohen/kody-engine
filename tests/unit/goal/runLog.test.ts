import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/stateRepo.js", () => ({
  appendStateLine: vi.fn(),
}))

import { flushGoalRunLogEvents, stageGoalRunLogEvent } from "../../../src/goal/runLog.js"
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

  it("writes staged goal events as JSONL under the state repo path", () => {
    const data: Record<string, unknown> = { jobId: "job 1" }

    stageGoalRunLogEvent(
      data,
      "web-release",
      {
        source: "goal-manager",
        event: "goal.tick.dispatch",
        goalType: "web-release",
        status: "dispatch",
        evidence: "releasePrExists",
        dispatch: {
          agentResponsibility: "release-prepare",
          agentAction: "release-prepare",
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
    })
  })
})
