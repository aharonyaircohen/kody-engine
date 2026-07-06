import { describe, expect, it } from "vitest"

import { type GoalRunLogEvent, goalRunTrace } from "../../src/goal/runLog.js"

describe("goal run trace", () => {
  it("summarizes a goal dispatch event into joinable trace fields", () => {
    const event: GoalRunLogEvent = {
      version: 1,
      time: "2026-07-02T00:00:00.000Z",
      source: "goal-manager",
      event: "goal.tick.dispatch",
      goalId: "web-release",
      goalType: "release",
      goalState: "active",
      stage: "prepare",
      evidence: "releasePrExists",
      status: "dispatch",
      dispatch: {
        capability: "release-prepare",
        implementation: "release-prepare",
        cliArgs: { version: "1.2.3" },
      },
      goal: {
        id: "web-release",
        state: "active",
        requiredEvidence: ["releasePrExists", "mainMerged"],
        satisfiedEvidence: [],
        missingEvidence: ["releasePrExists", "mainMerged"],
        pendingEvidence: "releasePrExists",
      },
      run: {
        id: "gh-123-1",
        githubRunId: "123",
      },
      trigger: {
        kind: "schedule",
      },
      links: {
        workflowRun: "https://github.com/o/r/actions/runs/123",
      },
    }

    expect(goalRunTrace(event)).toEqual({
      version: 1,
      runId: "gh-123-1",
      workflowRunId: "123",
      triggerKind: "schedule",
      source: "goal-manager",
      event: "goal.tick.dispatch",
      goal: {
        id: "web-release",
        type: "release",
        state: "active",
        stage: "prepare",
      },
      evidence: {
        current: "releasePrExists",
        required: ["releasePrExists", "mainMerged"],
        satisfied: [],
        missing: ["releasePrExists", "mainMerged"],
        pending: "releasePrExists",
      },
      capability: {
        capability: "release-prepare",
        implementation: "release-prepare",
        cliArgs: { version: "1.2.3" },
      },
      result: {
        status: "dispatch",
      },
      links: {
        workflowRun: "https://github.com/o/r/actions/runs/123",
      },
    })
  })
})
