import { describe, expect, it } from "vitest"

import { applyAgentResponsibilityReportToGoalState, type AgentResponsibilityReport, parseAgentResponsibilityReportsFromText } from "../../src/agent-responsibilityReport.js"
import type { GoalState } from "../../src/goal/state.js"

describe("parseAgentResponsibilityReportsFromText", () => {
  it("parses a single-line KODY_AGENT_RESPONSIBILITY_REPORT json marker", () => {
    const reports = parseAgentResponsibilityReportsFromText(
      'hello\nKODY_AGENT_RESPONSIBILITY_REPORT={"target":{"type":"goal","id":"release-aguy"},"evidence":{"releasePrExists":true},"facts":{"releasePr":123}}\n',
    )

    expect(reports).toEqual([
      {
        target: { type: "goal", id: "release-aguy" },
        evidence: { releasePrExists: true },
        facts: { releasePr: 123 },
      },
    ])
  })

  it("ignores malformed report lines instead of throwing", () => {
    expect(parseAgentResponsibilityReportsFromText("KODY_AGENT_RESPONSIBILITY_REPORT={not json}\n")).toEqual([])
    expect(parseAgentResponsibilityReportsFromText('KODY_AGENT_RESPONSIBILITY_REPORT={"target":{"type":"goal"}}\n')).toEqual([])
  })
})

describe("applyAgentResponsibilityReportToGoalState", () => {
  it("merges facts and true evidence into goal facts", () => {
    const state: GoalState = {
      state: "active",
      extra: {
        type: "release",
        facts: { pendingEvidence: "releasePrExists" },
        blockers: [],
      },
    }
    const report: AgentResponsibilityReport = {
      target: { type: "goal", id: "release-aguy" },
      evidence: { releasePrExists: true },
      facts: { releasePr: 123, version: "1.2.3" },
    }

    const next = applyAgentResponsibilityReportToGoalState(state, report)

    expect(next.extra.facts).toEqual({
      releasePrExists: true,
      releasePr: 123,
      version: "1.2.3",
    })
  })

  it("clears pending evidence when the agentResponsibility reports that evidence false", () => {
    const state: GoalState = {
      state: "active",
      extra: {
        facts: { pendingEvidence: "ciGreen" },
      },
    }
    const report: AgentResponsibilityReport = {
      target: { type: "goal", id: "release-aguy" },
      evidence: { ciGreen: false },
      facts: { ciStatus: "pending" },
    }

    const next = applyAgentResponsibilityReportToGoalState(state, report)

    expect(next.extra.facts).toEqual({ ciGreen: false, ciStatus: "pending" })
  })

  it("does not let reports set stage, route, or other control fields", () => {
    const state: GoalState = { state: "active", extra: { stage: "prepare", facts: {}, blockers: [] } }
    const report: AgentResponsibilityReport = {
      target: { type: "goal", id: "release-aguy" },
      facts: { stage: "done", route: [], releasePrGreen: true },
    }

    const next = applyAgentResponsibilityReportToGoalState(state, report)

    expect(next.extra.stage).toBe("prepare")
    expect(next.extra.route).toBeUndefined()
    expect(next.extra.facts).toEqual({ releasePrGreen: true })
  })
})
