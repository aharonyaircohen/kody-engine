import { describe, expect, it } from "vitest"
import { buildPrBody, buildPrTitle, recoverSourceIssueNumber, stripTitlePrefixes } from "../../src/pr.js"

describe("pr: buildPrTitle", () => {
  it("formats issue number and title", () => {
    expect(buildPrTitle(42, "Add feature X", false)).toBe("#42: Add feature X")
  })

  it("prefixes draft with [WIP]", () => {
    expect(buildPrTitle(42, "Add X", true)).toBe("[WIP] #42: Add X")
  })

  it("truncates long titles to 72 chars", () => {
    const long = "x".repeat(200)
    const result = buildPrTitle(1, long, false)
    expect(result.length).toBeLessThanOrEqual(72)
    expect(result.endsWith("…")).toBe(true)
  })

  it("strips pre-existing [WIP] #N: / #N: prefixes to prevent stacking", () => {
    // Title fetched from an existing PR may already include the WIP prefix.
    // Wrapping it again would stack: "[WIP] #42: [WIP] #42: Add X".
    expect(buildPrTitle(42, "[WIP] #42: Add X", true)).toBe("[WIP] #42: Add X")
    expect(buildPrTitle(42, "[WIP] #42: [WIP] #42: Add X", true)).toBe("[WIP] #42: Add X")
    expect(buildPrTitle(42, "#42: Add X", false)).toBe("#42: Add X")
  })
})

describe("pr: stripTitlePrefixes", () => {
  it("peels a single [WIP] #N: prefix", () => {
    expect(stripTitlePrefixes("[WIP] #42: hello")).toBe("hello")
  })

  it("peels a single #N: prefix", () => {
    expect(stripTitlePrefixes("#42: hello")).toBe("hello")
  })

  it("peels multiple stacked prefixes", () => {
    expect(stripTitlePrefixes("[WIP] #1: [WIP] #1: #1: title")).toBe("title")
  })

  it("returns raw title untouched when no prefix present", () => {
    expect(stripTitlePrefixes("plain title")).toBe("plain title")
  })
})

describe("pr: buildPrBody", () => {
  const baseOpts = {
    branch: "1-foo",
    defaultBranch: "main",
    issueNumber: 5,
    issueTitle: "Add Y",
    draft: false,
    changedFiles: ["src/foo.ts", "src/bar.ts"],
    cwd: ".",
  }

  it("includes Summary section and Closes #N", () => {
    const body = buildPrBody(baseOpts)
    expect(body).toMatch(/## Summary/)
    expect(body).toMatch(/Closes #5/)
  })

  it("uses agentSummary when supplied (instead of generic restatement)", () => {
    const body = buildPrBody({ ...baseOpts, agentSummary: "- Added /api/x\n- Wired into Y collection" })
    expect(body).toMatch(/Added \/api\/x/)
    expect(body).toMatch(/Wired into Y collection/)
    expect(body).not.toMatch(/Implementation of issue/)
  })

  it("falls back to generic restatement + warning when agentSummary missing", () => {
    const body = buildPrBody(baseOpts)
    expect(body).toMatch(/Implementation of issue #5/)
    expect(body).toMatch(/agent did not supply PR_SUMMARY/)
  })

  it("includes Changes list with backticked file names", () => {
    const body = buildPrBody(baseOpts)
    expect(body).toMatch(/## Changes/)
    expect(body).toMatch(/`src\/foo\.ts`/)
    expect(body).toMatch(/`src\/bar\.ts`/)
  })

  it("prefixes draft body with single-line headline + pre-existing-warning", () => {
    const body = buildPrBody({ ...baseOpts, draft: true, failureReason: "verify failed: typecheck" })
    expect(body.startsWith("> ⚠️ Draft: verify failed: typecheck\n")).toBe(true)
    expect(body).toMatch(/pre-existing/)
  })

  it("hides multi-line failure reason in a collapsible details block", () => {
    const huge = `verify failed: typecheck\n${"ERROR ".repeat(2000)}`
    const body = buildPrBody({ ...baseOpts, draft: true, failureReason: huge })
    const headline = body.split("\n")[0]!
    expect(headline.length).toBeLessThan(220)
    expect(body).toMatch(/<details>/)
    expect(body).toMatch(/Verify output \(click to expand\)/)
    expect(body).toMatch(/<\/details>/)
  })

  it("places Summary and Closes #N before any details block", () => {
    const body = buildPrBody({ ...baseOpts, draft: true, failureReason: "verify failed: lint" })
    const summaryIdx = body.indexOf("## Summary")
    const closesIdx = body.indexOf("Closes #")
    const detailsIdx = body.indexOf("<details>")
    expect(summaryIdx).toBeLessThan(detailsIdx)
    expect(closesIdx).toBeLessThan(detailsIdx)
  })

  it("omits Changes section when no files changed", () => {
    const body = buildPrBody({ ...baseOpts, changedFiles: [] })
    expect(body).not.toMatch(/## Changes/)
  })

  it("caps Changes list at 50 entries", () => {
    const many = Array.from({ length: 60 }, (_, i) => `src/file${i}.ts`)
    const body = buildPrBody({ ...baseOpts, changedFiles: many })
    const matches = body.match(/`src\/file\d+\.ts`/g) ?? []
    expect(matches.length).toBe(50)
    expect(body).toMatch(/and 10 more/)
  })
})

describe("pr: recoverSourceIssueNumber", () => {
  it("extracts the real issue number from existing body's Closes line", () => {
    // PR #1326 was opened against issue #1082. A fix cycle is about to rebuild
    // the body — without this, it would overwrite `Closes #1082` with
    // `Closes #1326` (the PR's own number), breaking GitHub auto-close.
    const body = "## Summary\n\n...\n\nCloses #1082\n"
    expect(recoverSourceIssueNumber(body, "1082-admin-should-see", 1326)).toBe(1082)
  })

  it("ignores a Closes line that points to the PR's own number (self-reference)", () => {
    // An earlier buggy fix-cycle run already corrupted the body once. We must
    // not re-propagate the corruption; fall through to the branch name.
    const body = "## Summary\n\n...\n\nCloses #1326\n"
    expect(recoverSourceIssueNumber(body, "1082-admin-should-see", 1326)).toBe(1082)
  })

  it("falls back to branch name leading digits when body has no Closes line", () => {
    expect(recoverSourceIssueNumber("## Summary\n\n(no marker)\n", "1082-admin", 1326)).toBe(1082)
  })

  it("returns null when body and branch both fail to yield a valid source issue", () => {
    expect(recoverSourceIssueNumber("## Summary\n\n(no marker)\n", "feature-x", 1326)).toBeNull()
  })

  it("returns null when the branch-parsed number equals the PR's own number", () => {
    // Avoids the same self-reference trap as the body-parse case.
    expect(recoverSourceIssueNumber("", "1326-slug", 1326)).toBeNull()
  })
})
