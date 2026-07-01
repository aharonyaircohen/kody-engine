import { describe, expect, it } from "vitest"
import { parseManifestBody, serializeManifestBody, splitReport } from "../../src/scripts/createQaGoal.js"

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
