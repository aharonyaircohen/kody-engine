import { describe, expect, it } from "vitest"
import {
  buildAgentLoopState,
  buildManagedGoalState,
  parseCompanyManagerDecisionText,
} from "../../src/companyManagerDecision.js"

describe("company manager decision", () => {
  it("parses fenced CTO decision JSON", () => {
    const decision = parseCompanyManagerDecisionText(`
DONE

\`\`\`kody-company-manager-decision
{
  "summary": "Create release portfolio",
  "actions": [
    {
      "kind": "createManagedGoal",
      "intentId": "release-confidence",
      "id": "publish-current-release",
      "outcome": "Publish current release safely",
      "evidence": ["releasePrExists"],
      "agentResponsibilities": ["release"],
      "route": [
        { "stage": "release", "evidence": "releasePrExists", "agentResponsibility": "release" }
      ],
      "reason": "release confidence requires tracked release proof"
    }
  ]
}
\`\`\`
`)

    expect(decision.summary).toBe("Create release portfolio")
    expect(decision.actions).toHaveLength(1)
    expect(decision.actions[0]).toMatchObject({
      kind: "createManagedGoal",
      intentId: "release-confidence",
      id: "publish-current-release",
    })
  })

  it("accepts content alias for note decisions", () => {
    const decision = parseCompanyManagerDecisionText(`\`\`\`kody-company-manager-decision
{"summary":"No portfolio changes","actions":[{"kind":"note","content":"Live integration test active; no goals or loops created."}]}
\`\`\``)

    expect(decision.actions).toEqual([
      {
        kind: "note",
        intentId: undefined,
        message: "Live integration test active; no goals or loops created.",
      },
    ])
  })

  it("builds managed goal state from createManagedGoal action", () => {
    const decision = parseCompanyManagerDecisionText(`
\`\`\`json
{
  "actions": [
    {
      "kind": "createManagedGoal",
      "intentId": "release-confidence",
      "id": "publish-current-release",
      "outcome": "Publish current release safely",
      "evidence": ["releasePrExists"],
      "agentResponsibilities": ["release"],
      "route": [
        { "stage": "release", "evidence": "releasePrExists", "agentResponsibility": "release" }
      ],
      "reason": "release confidence requires tracked release proof"
    }
  ]
}
\`\`\`
`)
    const action = decision.actions[0]
    if (!action || action.kind !== "createManagedGoal") throw new Error("expected createManagedGoal")

    expect(buildManagedGoalState(action)).toMatchObject({
      state: "active",
      extra: {
        type: "release",
        destination: { outcome: "Publish current release safely", evidence: ["releasePrExists"] },
        agentResponsibilities: ["release"],
        createdByIntent: "release-confidence",
        manager: "cto",
      },
    })
  })

  it("builds agent loop state from createAgentLoop action", () => {
    const decision = parseCompanyManagerDecisionText(`
KODY_COMPANY_MANAGER_DECISION={"actions":[{"kind":"createAgentLoop","intentId":"release-confidence","id":"release-health-loop","outcome":"Watch release health","every":"1d","agentResponsibilities":["ci-health"],"reason":"release confidence needs health checks"}]}
`)
    const action = decision.actions[0]
    if (!action || action.kind !== "createAgentLoop") throw new Error("expected createAgentLoop")

    expect(buildAgentLoopState(action)).toMatchObject({
      state: "active",
      extra: {
        type: "agentLoop",
        scheduleMode: "agentLoop",
        schedule: "1d",
        agentResponsibilities: ["ci-health"],
        createdByIntent: "release-confidence",
      },
    })
  })
})
