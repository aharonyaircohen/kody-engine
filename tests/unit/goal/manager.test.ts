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
    agentResponsibilities: ["release-prepare", "qa-goal", "npm-publish"],
    route: [
      { evidence: "releasePrExists", stage: "prepare", agentResponsibility: "release-prepare", agentAction: "release-prepare" },
      { evidence: "qaPassed", stage: "qa", agentResponsibility: "qa-goal", agentAction: "qa-goal", args: { issue: 123 } },
      { evidence: "packagePublished", stage: "publish", agentResponsibility: "npm-publish", agentAction: "npm-publish" },
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
    agentResponsibilities: [],
    route: [],
    stage: "legacy",
    facts: {},
    blockers: [],
    ...overrides,
  }
}

describe("planManagedGoalTick", () => {
  it("dispatches the first missing evidence through an attached agentResponsibility", () => {
    const goal = releaseGoal()

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({
      kind: "dispatch",
      evidence: "releasePrExists",
      stage: "prepare",
      agentResponsibility: "release-prepare",
      agentAction: "release-prepare",
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
      agentResponsibility: "qa-goal",
      agentAction: "qa-goal",
      cliArgs: { issue: 123 },
    })
    expect(goal.stage).toBe("qa")
    expect(goal.facts.pendingEvidence).toBe("qaPassed")
  })

  it("resolves route args from reported facts", () => {
    const goal = releaseGoal({
      facts: { releasePrExists: true, deployPr: 456 },
      route: [
        { evidence: "releasePrExists", stage: "prepare", agentResponsibility: "release-prepare", agentAction: "release-prepare" },
        {
          evidence: "qaPassed",
          stage: "qa",
          agentResponsibility: "qa-goal",
          agentAction: "qa-goal",
          args: { pr: { fact: "deployPr" }, issue: 123 },
        },
        { evidence: "packagePublished", stage: "publish", agentResponsibility: "npm-publish", agentAction: "npm-publish" },
      ],
    })

    const decision = planManagedGoalTick(goal)

    expect(decision).toMatchObject({
      kind: "dispatch",
      evidence: "qaPassed",
      cliArgs: { pr: 456, issue: 123 },
    })
  })

  it("can dispatch a agentResponsibility without naming its agentAction", () => {
    const goal = releaseGoal({
      destination: {
        outcome: "release PR is green",
        evidence: ["releasePrExists", "mainDeployPrGreen"],
      },
      agentResponsibilities: ["release-prepare", "ci-health"],
      route: [
        { evidence: "releasePrExists", stage: "prepare", agentResponsibility: "release-prepare", agentAction: "release-prepare" },
        {
          evidence: "mainDeployPrGreen",
          stage: "wait-ci",
          agentResponsibility: "ci-health",
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
      agentResponsibility: "ci-health",
      agentAction: undefined,
      cliArgs: { pr: 456, evidence: "mainDeployPrGreen" },
    })
  })

  it("blocks when route arg references missing fact", () => {
    const goal = releaseGoal({
      facts: { releasePrExists: true },
      route: [
        { evidence: "releasePrExists", stage: "prepare", agentResponsibility: "release-prepare", agentAction: "release-prepare" },
        {
          evidence: "qaPassed",
          stage: "qa",
          agentResponsibility: "qa-goal",
          agentAction: "qa-goal",
          args: { pr: { fact: "deployPr" } },
        },
        { evidence: "packagePublished", stage: "publish", agentResponsibility: "npm-publish", agentAction: "npm-publish" },
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

  it("waits instead of redispatching while evidence is pending", () => {
    const goal = releaseGoal({ stage: "prepare", facts: { pendingEvidence: "releasePrExists" } })

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({
      kind: "wait",
      evidence: "releasePrExists",
      stage: "prepare",
      reason: "waiting for evidence: releasePrExists",
    })
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

  it("blocks when the route requires a agentResponsibility not attached to the goal", () => {
    const goal = releaseGoal({ agentResponsibilities: ["qa-goal", "npm-publish"] })

    const decision = planManagedGoalTick(goal)

    expect(decision).toEqual({
      kind: "blocked",
      evidence: "releasePrExists",
      stage: "prepare",
      reason: "route agentResponsibility release-prepare is not attached to this goal",
    })
    expect(goal.stage).toBe("blocked")
    expect(goal.blockers).toEqual(["route agentResponsibility release-prepare is not attached to this goal"])
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

  it("writes manager fields back without dropping unrelated extras", () => {
    const state = writeManagedGoalToState(
      { state: "active", extra: { title: "Release 1.2.3" } },
      releaseGoal({ stage: "qa", facts: { releasePrExists: true } }),
    )

    expect(state.extra.title).toBe("Release 1.2.3")
    expect(state.extra.type).toBe("release")
    expect(state.extra.stage).toBe("qa")
    expect(state.extra.facts).toEqual({ releasePrExists: true })
  })
})
