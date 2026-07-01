import { describe, expect, it } from "vitest"

import {
  parseCapabilityResult,
  parseCapabilityResultsFromText,
} from "../../src/capabilityResult.js"
import { collectShellSideChannels } from "../../src/executor.js"

describe("parseCapabilityResult", () => {
  it("accepts the minimal valid capability result", () => {
    expect(
      parseCapabilityResult({
        version: 1,
        status: "pass",
        summary: "CI is green.",
      }),
    ).toEqual({
      version: 1,
      status: "pass",
      summary: "CI is green.",
      facts: {},
      artifacts: [],
      missingEvidence: [],
      blockers: [],
    })
  })

  it("accepts facts, artifacts, missing evidence, and blockers", () => {
    expect(
      parseCapabilityResult({
        version: 1,
        target: { type: "goal", id: "release-aguy" },
        status: "changed",
        summary: "Release PR created.",
        evidence: { releasePrExists: true },
        facts: { pr: 123, headSha: "abc123" },
        artifacts: [{ label: "Pull request", url: "https://github.com/example/repo/pull/123" }],
        missingEvidence: ["productionDeployed"],
        blockers: ["production deploy is waiting for CI"],
      }),
    ).toEqual({
      version: 1,
      target: { type: "goal", id: "release-aguy" },
      status: "changed",
      summary: "Release PR created.",
      evidence: { releasePrExists: true },
      facts: { pr: 123, headSha: "abc123" },
      artifacts: [{ label: "Pull request", url: "https://github.com/example/repo/pull/123" }],
      missingEvidence: ["productionDeployed"],
      blockers: ["production deploy is waiting for CI"],
    })
  })

  it("rejects invalid statuses and empty summaries", () => {
    expect(parseCapabilityResult({ version: 1, status: "ok", summary: "Done." })).toBeNull()
    expect(parseCapabilityResult({ version: 1, status: "pass", summary: " " })).toBeNull()
  })

  it("rejects malformed facts and artifacts", () => {
    expect(parseCapabilityResult({ version: 1, status: "pass", summary: "Done.", facts: [] })).toBeNull()
    expect(
      parseCapabilityResult({
        version: 1,
        status: "pass",
        summary: "Done.",
        artifacts: [{ label: "CI" }],
      }),
    ).toBeNull()
    expect(
      parseCapabilityResult({
        version: 1,
        status: "pass",
        summary: "Done.",
        target: { type: "unknown", id: "release-aguy" },
      }),
    ).toBeNull()
    expect(
      parseCapabilityResult({
        version: 1,
        status: "pass",
        summary: "Done.",
        evidence: { releasePrExists: "yes" },
      }),
    ).toBeNull()
    expect(
      parseCapabilityResult({
        version: 1,
        status: "pass",
        summary: "Done.",
        missingEvidence: "releasePrExists",
      }),
    ).toBeNull()
    expect(
      parseCapabilityResult({
        version: 1,
        status: "pass",
        summary: "Done.",
        blockers: [123],
      }),
    ).toBeNull()
  })
})

describe("parseCapabilityResultsFromText", () => {
  it("parses KODY_CAPABILITY_RESULT json markers", () => {
    const results = parseCapabilityResultsFromText(
      'before\nKODY_CAPABILITY_RESULT={"version":1,"status":"fail","summary":"CI failed.","facts":{"check":"test"}}\nafter\n',
    )

    expect(results).toEqual([
      {
        version: 1,
        status: "fail",
        summary: "CI failed.",
        facts: { check: "test" },
        artifacts: [],
        missingEvidence: [],
        blockers: [],
      },
    ])
  })

  it("ignores malformed marker lines", () => {
    expect(parseCapabilityResultsFromText("KODY_CAPABILITY_RESULT={not json}\n")).toEqual([])
    expect(
      parseCapabilityResultsFromText('KODY_CAPABILITY_RESULT={"version":1,"status":"pass"}\n'),
    ).toEqual([])
  })
})

describe("collectShellSideChannels", () => {
  it("collects capability results from shell output", () => {
    const ctx = { data: {}, output: { exitCode: 0 } }

    collectShellSideChannels(
      ctx,
      'KODY_CAPABILITY_RESULT={"version":1,"status":"pass","summary":"CI is green.","facts":{"pr":123}}\n',
    )

    expect(ctx.data).toEqual({
      capabilityResults: [
        {
          version: 1,
          status: "pass",
          summary: "CI is green.",
          facts: { pr: 123 },
          artifacts: [],
          missingEvidence: [],
          blockers: [],
        },
      ],
      dutyResults: [
        {
          version: 1,
          status: "pass",
          summary: "CI is green.",
          facts: { pr: 123 },
          artifacts: [],
          missingEvidence: [],
          blockers: [],
        },
      ],
    })
  })
})
