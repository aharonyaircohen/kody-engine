import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  gh: vi.fn(),
  postIssueComment: vi.fn(),
}))

vi.mock("../../src/issue.js", async (orig) => {
  const actual = (await orig()) as typeof import("../../src/issue.js")
  return { ...actual, gh: mocks.gh, postIssueComment: mocks.postIssueComment }
})

import type { AgentResult } from "../../src/agent.js"
import type { Context, Profile } from "../../src/implementations/types.js"
import { createQaGoal, parseManifestBody, serializeManifestBody, splitReport } from "../../src/scripts/createQaGoal.js"

function makeCtx(args: Record<string, unknown>): Context {
  return {
    args,
    cwd: "/repo",
    config: { github: { owner: "acme", repo: "widget" } } as never,
    data: {},
    output: { exitCode: 0 },
  } as Context
}

function makeAgent(finalText: string): AgentResult {
  return { outcome: "completed", finalText, ndjsonPath: "/tmp/x.jsonl" } as AgentResult
}

beforeEach(() => {
  mocks.gh.mockReset()
  mocks.postIssueComment.mockReset()
})

describe("createQaGoal: splitReport", () => {
  it("returns the markdown without a JSON block", () => {
    const text = "## Verdict: PASS\n\nNothing to see here.\n"
    const { markdown, data, jsonError } = splitReport(text)
    expect(markdown).toBe("## Verdict: PASS\n\nNothing to see here.")
    expect(data).toBeNull()
    expect(jsonError).toBe("no JSON block marker")
  })

  it("extracts findings from a JSON block at the end", () => {
    const text = `## Verdict: CONCERNS

### Findings
- **[P1] Login is busted**

<!-- KODY_QA_REPORT_JSON
\`\`\`json
{
  "findings": [
    {
      "severity": "P1",
      "title": "Login is busted",
      "route": "/login",
      "steps": "1. open page\\n2. submit",
      "expected": "log in",
      "actual": "500"
    }
  ]
}
\`\`\`
-->
`
    const { markdown, data, jsonError } = splitReport(text)
    expect(jsonError).toBeUndefined()
    expect(data?.findings).toHaveLength(1)
    expect(data?.findings[0].severity).toBe("P1")
    expect(data?.findings[0].title).toBe("Login is busted")
    expect(data?.findings[0].route).toBe("/login")
    expect(markdown).not.toContain("KODY_QA_REPORT_JSON")
    expect(markdown).toContain("### Findings")
  })

  it("accepts a JSON block without ```json fencing", () => {
    const text = `Some preamble.

<!-- KODY_QA_REPORT_JSON
{"findings": []}
-->
`
    const { data, jsonError } = splitReport(text)
    expect(jsonError).toBeUndefined()
    expect(data).toEqual({ findings: [] })
  })

  it("returns a parse error when JSON is malformed", () => {
    const text = `Body.

<!-- KODY_QA_REPORT_JSON
{not valid json
-->
`
    const { data, jsonError } = splitReport(text)
    expect(data).toBeNull()
    expect(jsonError).toMatch(/.+/)
  })

  it("returns a parse error when JSON lacks findings array", () => {
    const text = `Body.

<!-- KODY_QA_REPORT_JSON
{"verdict": "PASS"}
-->
`
    const { data, jsonError } = splitReport(text)
    expect(data).toBeNull()
    expect(jsonError).toBe("JSON missing 'findings' array")
  })

  it("flags an unterminated block", () => {
    const text = `Body.

<!-- KODY_QA_REPORT_JSON
{"findings": []}
`
    const { data, jsonError } = splitReport(text)
    expect(data).toBeNull()
    expect(jsonError).toBe("JSON block not terminated")
  })

  it("normalizes plain fenced findings JSON when the marker is missing", () => {
    const text = `# QA Report

## Findings

\`\`\`json
{
  "verdict": "partial",
  "findings": [
    {
      "severity": "high",
      "route": "/login",
      "summary": "Raw i18n key is visible",
      "repro": "Open /login",
      "evidence": ["qa-login.png"]
    },
    {
      "severity": "low",
      "route": "/api-status",
      "summary": "Secondary text says unknown (unknown)"
    }
  ]
}
\`\`\`
`
    const { markdown, data, jsonError } = splitReport(text)
    expect(jsonError).toBeUndefined()
    expect(markdown).not.toContain('"findings"')
    expect(data?.findings).toHaveLength(2)
    expect(data?.findings[0]).toMatchObject({
      severity: "P1",
      title: "Raw i18n key is visible",
      route: "/login",
      steps: "Open /login",
      actual: "Raw i18n key is visible",
      evidence: "qa-login.png",
    })
    expect(data?.findings[1].severity).toBe("P3")
  })
})

describe("createQaGoal: manifest body roundtrip", () => {
  it("parses and serializes a manifest preserving goals", () => {
    const original = {
      version: 1 as const,
      goals: [
        {
          id: "goal-a",
          name: "Goal A",
          description: "first",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "goal-b",
          name: "Goal B",
          createdAt: "2026-01-02T00:00:00Z",
        },
      ],
    }
    const body = serializeManifestBody(original)
    expect(body).toContain("kody-goals-start")
    expect(body).toContain("kody-goals-end")
    const parsed = parseManifestBody(body)
    expect(parsed.goals).toHaveLength(2)
    expect(parsed.goals[0].id).toBe("goal-a")
    expect(parsed.goals[1].id).toBe("goal-b")
  })

  it("returns an empty manifest for missing markers", () => {
    expect(parseManifestBody("just a body").goals).toHaveLength(0)
    expect(parseManifestBody("").goals).toHaveLength(0)
    expect(parseManifestBody(null).goals).toHaveLength(0)
  })

  it("returns an empty manifest for malformed JSON inside the block", () => {
    const broken = `<!-- kody-goals-start -->\n\n\`\`\`json\n{not valid\n\`\`\`\n\n<!-- kody-goals-end -->`
    expect(parseManifestBody(broken).goals).toHaveLength(0)
  })
})

describe("createQaGoal: existing tracking issue", () => {
  it("posts the report and marks the issue with kody:qa-report", async () => {
    const ctx = makeCtx({ issue: 687 })

    await createQaGoal(ctx, {} as Profile, makeAgent("## Verdict: PASS\n\nNo findings."))

    expect(mocks.postIssueComment).toHaveBeenCalledWith(687, "## Verdict: PASS\n\nNo findings.", "/repo")
    expect(mocks.gh).toHaveBeenCalledWith(
      ["label", "create", "kody:qa-report", "--color", "8b5cf6", "--description", "kody: QA report", "--force"],
      { cwd: "/repo" },
    )
    expect(mocks.gh).toHaveBeenCalledWith(["issue", "edit", "687", "--add-label", "kody:qa-report"], { cwd: "/repo" })
    expect(ctx.output.exitCode).toBe(0)
    expect((ctx.data.action as { type: string }).type).toBe("QA_PASS")
  })
})
