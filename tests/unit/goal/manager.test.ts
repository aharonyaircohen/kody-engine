import { describe, expect, it } from "vitest"

import {
  applySimpleGoalTaskSummary,
  type ManagedGoal,
  managedGoalFromState,
  planManagedGoalTick,
  SIMPLE_GOAL_EVIDENCE,
  writeManagedGoalToState,
} from "../../../src/goal/manager.js"

function releaseGoal(overrides: Partial<ManagedGoal> = {}): ManagedGoal {
  return {
    type: "release",
    destination: {
      outcome: "version 1.2.3 is published and verified",
      evidence: ["releasePrExists", "qaPassed", "packagePublished"],
    },
    capabilities: ["release-prepare", "qa-goal", "npm-publish"],
    route: [
      {
        evidence: "releasePrExists",
        stage: "prepare",
        capability: "release-prepare",
        implementation: "release-prepare",
      },
      {
        evidence: "qaPassed",
        stage: "qa",
        capability: "qa-goal",
        implementation: "qa-goal",
        args: { issue: 123 },
      },
      {
        evidence: "packagePublished",
        stage: "publish",
        capability: "npm-publish",
        implementation: "npm-publish",
      },
    ],
    stage: "prepare",
    facts: {},
    blockers: [],
    ...overrides,
  }
}

function simpleGoal(overrides: Partial<ManagedGoal> = {}): ManagedGoal {
  return {
    type: "simple",
    destination: {
      outcome: "all labelled tasks are complete",
      evidence: [SIMPLE_GOAL_EVIDENCE],
    },
    capabilities: [],
    route: [],
    stage: "legacy",
    facts: {},
    blockers: [],
    ...overrides,
  }
}

describe("planManagedGoalTick", () => {
  it("dispatches the first missing evidence through an attached capability", () => {
    const goal = releaseGoal()

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({
      kind: "dispatch",
      evidence: "releasePrExists",
      stage: "prepare",
      capability: "release-prepare",
      implementation: "release-prepare",
      cliArgs: {},
    })
    expect(goal.stage).toBe("prepare")
    expect(goal.facts.pendingEvidence).toBe("releasePrExists")
    expect(goal.blockers).toEqual([])
  })

  it("uses the next missing evidence once earlier evidence exists", () => {
    const goal = releaseGoal({ facts: { releasePrExists: true } })

    const decision = planManagedGoalTick(goal)

    expect(decision).toMatchObject({
      kind: "dispatch",
      evidence: "qaPassed",
      stage: "qa",
      capability: "qa-goal",
      implementation: "qa-goal",
      cliArgs: { issue: 123 },
    })
    expect(goal.stage).toBe("qa")
    expect(goal.facts.pendingEvidence).toBe("qaPassed")
  })

  it("resolves route args from reported facts", () => {
    const goal = releaseGoal({
      facts: { releasePrExists: true, deployPr: 456 },
      route: [
        {
          evidence: "releasePrExists",
          stage: "prepare",
          capability: "release-prepare",
          implementation: "release-prepare",
        },
        {
          evidence: "qaPassed",
          stage: "qa",
          capability: "qa-goal",
          implementation: "qa-goal",
          args: { pr: { fact: "deployPr" }, issue: 123 },
        },
        {
          evidence: "packagePublished",
          stage: "publish",
          capability: "npm-publish",
          implementation: "npm-publish",
        },
      ],
    })

    const decision = planManagedGoalTick(goal)

    expect(decision).toMatchObject({
      kind: "dispatch",
      evidence: "qaPassed",
      cliArgs: { pr: 456, issue: 123 },
    })
  })

  it("can dispatch a capability without naming its executable", () => {
    const goal = releaseGoal({
      destination: {
        outcome: "release PR is green",
        evidence: ["releasePrExists", "mainDeployPrGreen"],
      },
      capabilities: ["release-prepare", "ci-health"],
      route: [
        {
          evidence: "releasePrExists",
          stage: "prepare",
          capability: "release-prepare",
          implementation: "release-prepare",
        },
        {
          evidence: "mainDeployPrGreen",
          stage: "wait-ci",
          capability: "ci-health",
          args: { pr: { fact: "releasePr" }, evidence: "mainDeployPrGreen" },
        },
      ],
      facts: { releasePrExists: true, releasePr: 456 },
    })

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({
      kind: "dispatch",
      evidence: "mainDeployPrGreen",
      stage: "wait-ci",
      capability: "ci-health",
      cliArgs: { pr: 456, evidence: "mainDeployPrGreen" },
    })
  })

  it("blocks when route arg references missing fact", () => {
    const goal = releaseGoal({
      facts: { releasePrExists: true },
      route: [
        {
          evidence: "releasePrExists",
          stage: "prepare",
          capability: "release-prepare",
          implementation: "release-prepare",
        },
        {
          evidence: "qaPassed",
          stage: "qa",
          capability: "qa-goal",
          implementation: "qa-goal",
          args: { pr: { fact: "deployPr" } },
        },
        {
          evidence: "packagePublished",
          stage: "publish",
          capability: "npm-publish",
          implementation: "npm-publish",
        },
      ],
    })

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({
      kind: "blocked",
      evidence: "qaPassed",
      stage: "qa",
      reason: "route arg pr needs missing fact deployPr",
    })
    expect(goal.blockers).toEqual(["route arg pr needs missing fact deployPr"])
  })

  it("redispatches pending evidence when it is still missing", () => {
    const goal = releaseGoal({ stage: "prepare", facts: { pendingEvidence: "releasePrExists" } })

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({
      kind: "dispatch",
      evidence: "releasePrExists",
      stage: "prepare",
      capability: "release-prepare",
      implementation: "release-prepare",
      cliArgs: {},
    })
    expect(goal.facts.pendingEvidence).toBe("releasePrExists")
    expect(goal.blockers).toEqual([])
  })

  it("waits when the current evidence is pending", () => {
    const goal = releaseGoal({
      stage: "prepare",
      facts: { pendingEvidence: "releasePrExists" },
      evidenceState: {
        releasePrExists: {
          resultClass: "pending",
          attempts: 1,
          reason: "Fast Gate is still running.",
          nextAction: "wait",
        },
      },
    })

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({
      kind: "wait",
      evidence: "releasePrExists",
      stage: "prepare",
      reason: "Fast Gate is still running.",
    })
    expect(goal.nextAction).toBe("wait")
  })

  it("waits until retryable evidence reaches nextRetryAt", () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const goal = releaseGoal({
      stage: "prepare",
      facts: { pendingEvidence: "releasePrExists" },
      evidenceState: {
        releasePrExists: {
          resultClass: "retryable",
          attempts: 1,
          reason: "GitHub was temporarily unavailable.",
          nextAction: "retry",
          nextRetryAt: future,
        },
      },
    })

    const decision = planManagedGoalTick(goal)

    expect(decision).toMatchObject({
      kind: "wait",
      evidence: "releasePrExists",
      stage: "prepare",
      reason: "GitHub was temporarily unavailable.",
    })
    expect(goal.nextAction).toBe(`retry after ${future}`)
  })

  it("dispatches retryable evidence when retry time has passed", () => {
    const goal = releaseGoal({
      stage: "prepare",
      facts: { pendingEvidence: "releasePrExists" },
      evidenceState: {
        releasePrExists: {
          resultClass: "retryable",
          attempts: 1,
          reason: "GitHub was temporarily unavailable.",
          nextAction: "retry",
          nextRetryAt: "2020-01-01T00:00:00Z",
        },
      },
    })

    const decision = planManagedGoalTick(goal)

    expect(decision).toMatchObject({
      kind: "dispatch",
      evidence: "releasePrExists",
      capability: "release-prepare",
    })
  })

  it("dispatches workflow-backed goals through the linked workflow", () => {
    const goal = releaseGoal({
      workflowRef: {
        source: "store",
        id: "web-release",
        args: {
          issue: { fact: "issue" },
          goal: { fact: "goalId" },
        },
      },
      capabilities: [],
      route: [],
      stage: "workflow",
      facts: { issue: 42, goalId: "web-release-2026-07-05" },
    })

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({
      kind: "dispatchWorkflow",
      evidence: "releasePrExists",
      stage: "workflow",
      workflow: "web-release",
      cliArgs: { issue: 42, goal: "web-release-2026-07-05" },
    })
    expect(goal.stage).toBe("workflow")
    expect(goal.facts.pendingEvidence).toBe("releasePrExists")
    expect(goal.nextAction).toBe("dispatch workflow")
  })

  it("waits for pending workflow-backed evidence instead of restarting the workflow", () => {
    const goal = releaseGoal({
      workflowRef: { source: "store", id: "web-release" },
      capabilities: [],
      route: [],
      stage: "workflow",
      facts: { pendingEvidence: "releasePrExists" },
      evidenceState: {
        releasePrExists: {
          resultClass: "pending",
          attempts: 1,
          reason: "release PR is still open",
          nextAction: "wait",
        },
      },
    })

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({
      kind: "wait",
      evidence: "releasePrExists",
      stage: "workflow",
      reason: "release PR is still open",
    })
    expect(goal.nextAction).toBe("wait")
  })

  it("blocks needs-fix evidence with the linked issue as next action", () => {
    const goal = releaseGoal({
      stage: "prepare",
      facts: { releasePrExists: false },
      evidenceState: {
        releasePrExists: {
          resultClass: "needsFix",
          attempts: 1,
          reason: "Release PR failed validation.",
          nextAction: "fix issue #88",
          issue: 88,
        },
      },
    })

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({
      kind: "blocked",
      evidence: "releasePrExists",
      stage: "prepare",
      reason: "Release PR failed validation.",
    })
    expect(goal.nextAction).toBe("fix issue #88")
  })

  it("marks the goal complete when every destination evidence item is present", () => {
    const goal = releaseGoal({
      facts: { releasePrExists: true, qaPassed: true, packagePublished: true, pendingEvidence: "packagePublished" },
    })

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({ kind: "done" })
    expect(goal.stage).toBe("done")
    expect(goal.facts.pendingEvidence).toBeUndefined()
  })

  it("blocks when the route requires a capability not attached to the goal", () => {
    const goal = releaseGoal({ capabilities: ["qa-goal", "npm-publish"] })

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({
      kind: "blocked",
      evidence: "releasePrExists",
      stage: "prepare",
      reason: "route capability release-prepare is not attached to this goal",
    })
    expect(goal.stage).toBe("blocked")
    expect(goal.blockers).toEqual(["route capability release-prepare is not attached to this goal"])
  })
  it("waits for simple goal labelled tasks instead of blocking", () => {
    const goal = simpleGoal()
    applySimpleGoalTaskSummary(goal, { total: 2, open: 1 })

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({
      kind: "wait",
      evidence: SIMPLE_GOAL_EVIDENCE,
      stage: "waiting",
      reason: "waiting for 1 open labelled task(s)",
    })
    expect(goal.stage).toBe("waiting")
    expect(goal.blockers).toEqual([])
    expect(goal.facts[SIMPLE_GOAL_EVIDENCE]).toBe(false)
  })

  it("completes simple goal when all labelled tasks are closed", () => {
    const goal = simpleGoal()
    applySimpleGoalTaskSummary(goal, { total: 2, open: 0 })

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({ kind: "done" })
    expect(goal.stage).toBe("done")
    expect(goal.facts[SIMPLE_GOAL_EVIDENCE]).toBe(true)
  })
})

describe("managed goal state bridge", () => {
  it("reads manager fields from GoalState.extra", () => {
    const goal = managedGoalFromState({
      state: "active",
      extra: releaseGoal({ facts: { releasePrExists: true } }) as unknown as Record<string, unknown>,
    })

    expect(goal?.type).toBe("release")
    expect(goal?.facts.releasePrExists).toBe(true)
  })

  it("reads workflowRef from GoalState.extra", () => {
    const goal = managedGoalFromState({
      state: "active",
      extra: releaseGoal({
        workflowRef: {
          source: "store",
          id: "web-release",
          args: { issue: { fact: "issue" }, goal: { fact: "goalId" } },
        },
        capabilities: [],
        route: [],
      }) as unknown as Record<string, unknown>,
    })

    expect(goal?.workflowRef).toEqual({
      source: "store",
      id: "web-release",
      args: { issue: { fact: "issue" }, goal: { fact: "goalId" } },
    })
  })

  it("writes manager fields back without dropping unrelated extras", () => {
    const state = writeManagedGoalToState(
      { state: "active", extra: { title: "Release 1.2.3" } },
      releaseGoal({
        stage: "qa",
        facts: { releasePrExists: true },
        workflowRef: { source: "store", id: "web-release" },
      }),
    )

    expect(state.extra.title).toBe("Release 1.2.3")
    expect(state.extra.type).toBe("release")
    expect(state.extra.stage).toBe("qa")
    expect(state.extra.facts).toEqual({ releasePrExists: true })
    expect(state.extra.workflowRef).toEqual({ source: "store", id: "web-release" })
  })
})
