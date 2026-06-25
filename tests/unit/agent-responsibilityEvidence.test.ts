import { describe, expect, it } from "vitest"

import {
  agentResponsibilityReportToEvidence,
  agentResponsibilityResultToEvidence,
  applyAgentResponsibilityEvidenceToGoalState,
  mergeResponsibilityEvidence,
} from "../../src/agent-responsibilityEvidence.js"
import type { GoalState } from "../../src/goal/state.js"

describe("agent responsibility evidence", () => {
  it("converts goal reports into canonical responsibility evidence", () => {
    expect(
      agentResponsibilityReportToEvidence({
        target: { type: "goal", id: "release-aguy" },
        evidence: { releasePrExists: true },
        facts: { releasePr: 123 },
      }),
    ).toEqual({
      version: 1,
      target: { type: "goal", id: "release-aguy" },
      status: "changed",
      summary: "responsibility reported goal evidence",
      evidence: { releasePrExists: true },
      facts: { releasePr: 123 },
      artifacts: [],
      missingEvidence: [],
      blockers: [],
      sources: ["report"],
    })
  })

  it("converts result markers into canonical responsibility evidence", () => {
    expect(
      agentResponsibilityResultToEvidence(
        {
          version: 1,
          status: "pass",
          summary: "Release PR exists.",
          facts: { releasePr: 123 },
          artifacts: [{ label: "PR", url: "https://github.com/o/r/pull/123" }],
          missingEvidence: [],
          blockers: [],
        },
        "release-aguy",
        "releasePrExists",
      ),
    ).toEqual({
      version: 1,
      target: { type: "goal", id: "release-aguy" },
      status: "pass",
      summary: "Release PR exists.",
      explicitEvidence: "releasePrExists",
      facts: { releasePr: 123 },
      artifacts: [{ label: "PR", url: "https://github.com/o/r/pull/123" }],
      missingEvidence: [],
      blockers: [],
      sources: ["result"],
    })
  })

  it("merges matching report and result evidence into one item", () => {
    const merged = mergeResponsibilityEvidence([
      {
        version: 1,
        target: { type: "goal", id: "release-aguy" },
        status: "changed",
        summary: "responsibility reported goal evidence",
        evidence: { releasePrExists: true },
        facts: { releasePr: 123 },
        artifacts: [],
        missingEvidence: [],
        blockers: [],
        sources: ["report"],
      },
      {
        version: 1,
        target: { type: "goal", id: "release-aguy" },
        status: "pass",
        summary: "Release PR exists.",
        explicitEvidence: "releasePrExists",
        facts: { headSha: "abc123" },
        artifacts: [],
        missingEvidence: [],
        blockers: [],
        sources: ["result"],
      },
    ])

    expect(merged).toEqual([
      expect.objectContaining({
        status: "pass",
        summary: "Release PR exists.",
        evidence: { releasePrExists: true },
        facts: { releasePr: 123, headSha: "abc123" },
        sources: ["report", "result"],
      }),
    ])
  })

  it("applies responsibility evidence to goal progress state", () => {
    const state: GoalState = {
      state: "active",
      extra: {
        facts: { pendingEvidence: "releasePrExists" },
        blockers: [],
      },
    }

    const next = applyAgentResponsibilityEvidenceToGoalState(state, {
      version: 1,
      target: { type: "goal", id: "release-aguy" },
      status: "pass",
      summary: "Release PR exists.",
      evidence: { releasePrExists: true },
      facts: { releasePr: 123 },
      artifacts: [],
      missingEvidence: [],
      blockers: [],
      sources: ["report", "result"],
    })

    expect(next.extra.facts).toEqual({ releasePrExists: true, releasePr: 123 })
    expect(next.extra.blockers).toEqual([])
  })

  it("clears pending evidence when report-style changed evidence proves it", () => {
    const state: GoalState = {
      state: "active",
      extra: {
        facts: { pendingEvidence: "releasePrExists" },
      },
    }

    const next = applyAgentResponsibilityEvidenceToGoalState(state, {
      version: 1,
      target: { type: "goal", id: "release-aguy" },
      status: "changed",
      summary: "responsibility reported goal evidence",
      evidence: { releasePrExists: true },
      facts: {},
      artifacts: [],
      missingEvidence: [],
      blockers: [],
      sources: ["report"],
    })

    expect(next.extra.facts).toEqual({ releasePrExists: true })
  })
})
