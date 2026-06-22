import { describe, expect, it } from "vitest"

import { managedGoalFromState } from "../../../src/goal/manager.js"
import { expandManagedGoalState } from "../../../src/goal/typeDefinitions.js"
import type { GoalState } from "../../../src/goal/state.js"

describe("expandManagedGoalState", () => {
  it("expands a three-field release goal into a runnable managed goal", () => {
    const state: GoalState = {
      state: "active",
      extra: {
        type: "release",
        destination: { outcome: "Publish Kody Dashboard to production safely." },
      },
    }

    const expanded = expandManagedGoalState(state)
    const managed = managedGoalFromState(expanded)

    expect(managed).toMatchObject({
      type: "release",
      destination: {
        outcome: "Publish Kody Dashboard to production safely.",
        evidence: ["releasePrExists", "mainMerged", "productionDeployed"],
      },
      agentResponsibilities: ["release", "release-merge", "vercel-production-deploy"],
      route: [
        {
          stage: "release",
          evidence: "releasePrExists",
          agentResponsibility: "release",
          agentAction: "release-prepare",
          args: { issue: { fact: "issue" }, goal: { fact: "goalId" } },
        },
          {
            stage: "merge",
            evidence: "mainMerged",
            agentResponsibility: "release-merge",
            agentAction: "release-merge",
            args: { pr: { fact: "releasePr" }, issue: { fact: "issue" }, goal: { fact: "goalId" } },
          },
        {
          stage: "publish",
          evidence: "productionDeployed",
          agentResponsibility: "vercel-production-deploy",
          agentAction: "vercel-production-deploy",
          args: { goal: { fact: "goalId" } },
        },
      ],
      facts: {},
      blockers: [],
    })
  })

  it("preserves explicit route details on existing goals", () => {
    const state: GoalState = {
      state: "active",
      extra: {
        type: "release",
        destination: { outcome: "Release safely.", evidence: ["customEvidence"] },
        agentResponsibilities: ["custom-agentResponsibility"],
        route: [{ stage: "custom", evidence: "customEvidence", agentResponsibility: "custom-agentResponsibility" }],
        facts: { issue: 12 },
        blockers: ["keep"],
      },
    }

    const expanded = expandManagedGoalState(state)

    expect(expanded.extra.destination).toEqual({
      outcome: "Release safely.",
      evidence: ["customEvidence"],
    })
    expect(expanded.extra.agentResponsibilities).toEqual(["custom-agentResponsibility"])
    expect(expanded.extra.route).toEqual([{ stage: "custom", evidence: "customEvidence", agentResponsibility: "custom-agentResponsibility" }])
    expect(expanded.extra.facts).toEqual({ issue: 12 })
    expect(expanded.extra.blockers).toEqual(["keep"])
  })
})
