import { describe, expect, it } from "vitest"

import { parseAgentResponsibilityResult, parseAgentResponsibilityResultsFromText } from "../../src/agent-responsibilityResult.js"
import { collectShellSideChannels } from "../../src/executor.js"

describe("parseAgentResponsibilityResult", () => {
  it("accepts the minimal valid agentResponsibility result", () => {
    expect(
      parseAgentResponsibilityResult({
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
    })
  })

  it("accepts facts and artifacts", () => {
    expect(
      parseAgentResponsibilityResult({
        version: 1,
        status: "changed",
        summary: "Release PR created.",
        facts: { pr: 123, headSha: "abc123" },
        artifacts: [{ label: "Pull request", url: "https://github.com/example/repo/pull/123" }],
      }),
    ).toEqual({
      version: 1,
      status: "changed",
      summary: "Release PR created.",
      facts: { pr: 123, headSha: "abc123" },
      artifacts: [{ label: "Pull request", url: "https://github.com/example/repo/pull/123" }],
    })
  })

  it("rejects invalid statuses and empty summaries", () => {
    expect(parseAgentResponsibilityResult({ version: 1, status: "ok", summary: "Done." })).toBeNull()
    expect(parseAgentResponsibilityResult({ version: 1, status: "pass", summary: " " })).toBeNull()
  })

  it("rejects malformed facts and artifacts", () => {
    expect(parseAgentResponsibilityResult({ version: 1, status: "pass", summary: "Done.", facts: [] })).toBeNull()
    expect(
      parseAgentResponsibilityResult({
        version: 1,
        status: "pass",
        summary: "Done.",
        artifacts: [{ label: "CI" }],
      }),
    ).toBeNull()
  })
})

describe("parseAgentResponsibilityResultsFromText", () => {
  it("parses KODY_AGENT_RESPONSIBILITY_RESULT json markers", () => {
    const results = parseAgentResponsibilityResultsFromText(
      'before\nKODY_AGENT_RESPONSIBILITY_RESULT={"version":1,"status":"fail","summary":"CI failed.","facts":{"check":"test"}}\nafter\n',
    )

    expect(results).toEqual([
      {
        version: 1,
        status: "fail",
        summary: "CI failed.",
        facts: { check: "test" },
        artifacts: [],
      },
    ])
  })

  it("ignores malformed marker lines", () => {
    expect(parseAgentResponsibilityResultsFromText("KODY_AGENT_RESPONSIBILITY_RESULT={not json}\n")).toEqual([])
    expect(parseAgentResponsibilityResultsFromText('KODY_AGENT_RESPONSIBILITY_RESULT={"version":1,"status":"pass"}\n')).toEqual([])
  })
})

describe("collectShellSideChannels", () => {
  it("collects agentResponsibility results from shell output", () => {
    const ctx = { data: {}, output: { exitCode: 0 } }

    collectShellSideChannels(
      ctx,
      'KODY_AGENT_RESPONSIBILITY_RESULT={"version":1,"status":"pass","summary":"CI is green.","facts":{"pr":123}}\n',
    )

    expect(ctx.data).toEqual({
      dutyResults: [
        {
          version: 1,
          status: "pass",
          summary: "CI is green.",
          facts: { pr: 123 },
          artifacts: [],
        },
      ],
    })
  })
})
