import { describe, expect, it } from "vitest"

import {
  capabilityReportToEvidence,
  capabilityResultToEvidence,
  applyCapabilityEvidenceToGoalState,
  mergeCapabilityEvidence,
} from "../../src/capabilityEvidence.js"
import type { GoalState } from "../../src/goal/state.js"

describe("agent capability evidence", () => {
  it("converts goal reports into canonical capability evidence", () => {
    expect(
      capabilityReportToEvidence({
        target: { type: "goal", id: "release-aguy" },
        evidence: { releasePrExists: true },
        facts: { releasePr: 123 },
      }),
    ).toEqual({
      version: 1,
      target: { type: "goal", id: "release-aguy" },
      status: "changed",
      summary: "capability reported goal evidence",
      evidence: { releasePrExists: true },
      facts: { releasePr: 123 },
      artifacts: [],
      missingEvidence: [],
      blockers: [],
      sources: ["report"],
    })
  })

  it("converts result markers into canonical capability evidence", () => {
    expect(
      capabilityResultToEvidence(
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

  it("ignores result markers that explicitly target non-goal owners", () => {
    expect(
      capabilityResultToEvidence(
        {
          version: 1,
          target: { type: "task", id: "123" },
          status: "pass",
          summary: "Task evidence exists.",
          facts: { task: 123 },
          artifacts: [],
          missingEvidence: [],
          blockers: [],
        },
        "release-aguy",
        "releasePrExists",
      ),
    ).toBeNull()
  })

  it("does not attach legacy explicit evidence when result declares evidence values", () => {
    expect(
      capabilityResultToEvidence(
        {
          version: 1,
          target: { type: "goal", id: "release-aguy" },
          status: "pass",
          summary: "Production deployed.",
          evidence: { productionDeployed: true },
          facts: {},
          artifacts: [],
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
      summary: "Production deployed.",
      evidence: { productionDeployed: true },
      facts: {},
      artifacts: [],
      missingEvidence: [],
      blockers: [],
      sources: ["result"],
    })
  })

  it("merges matching report and result evidence into one item", () => {
    const merged = mergeCapabilityEvidence([
      {
        version: 1,
        target: { type: "goal", id: "release-aguy" },
        status: "changed",
        summary: "capability reported goal evidence",
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

  it("applies capability evidence to goal progress state", () => {
    const state: GoalState = {
      state: "active",
      extra: {
        facts: { pendingEvidence: "releasePrExists" },
        blockers: [],
      },
    }

    const next = applyCapabilityEvidenceToGoalState(state, {
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

    const next = applyCapabilityEvidenceToGoalState(state, {
      version: 1,
      target: { type: "goal", id: "release-aguy" },
      status: "changed",
      summary: "capability reported goal evidence",
      evidence: { releasePrExists: true },
      facts: {},
      artifacts: [],
      missingEvidence: [],
      blockers: [],
      sources: ["report"],
    })

    expect(next.extra.facts).toEqual({ releasePrExists: true })
  })

  it("does not map pass status to pending evidence when explicit evidence values exist", () => {
    const state: GoalState = {
      state: "active",
      extra: {
        facts: { pendingEvidence: "releasePrExists" },
      },
    }

    const next = applyCapabilityEvidenceToGoalState(state, {
      version: 1,
      target: { type: "goal", id: "release-aguy" },
      status: "pass",
      summary: "Production deployed.",
      evidence: { productionDeployed: true },
      facts: {},
      artifacts: [],
      missingEvidence: [],
      blockers: [],
      sources: ["result"],
    })

    expect(next.extra.facts).toEqual({
      pendingEvidence: "releasePrExists",
      productionDeployed: true,
    })
  })
})
