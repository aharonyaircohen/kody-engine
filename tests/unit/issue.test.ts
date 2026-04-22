import { describe, expect, it } from "vitest"
import { isReviewShaped, truncate } from "../../src/issue.js"

describe("issue: truncate", () => {
  it("returns string unchanged when within limit", () => {
    expect(truncate("hello", 100)).toBe("hello")
  })

  it("truncates long strings with ellipsis suffix", () => {
    const result = truncate("x".repeat(100), 50)
    expect(result.startsWith("x".repeat(50))).toBe(true)
    expect(result).toMatch(/\+50 chars/)
  })

  it("does not error on empty string", () => {
    expect(truncate("", 100)).toBe("")
  })

  it("handles exact-length input", () => {
    expect(truncate("12345", 5)).toBe("12345")
  })
})

describe("issue: isReviewShaped", () => {
  it("accepts a body with a `## Verdict:` heading", () => {
    expect(isReviewShaped("## Verdict: PASS\n\nBody")).toBe(true)
  })

  it("accepts a body with `### Verdict:` (any heading depth)", () => {
    expect(isReviewShaped("### Verdict: CONCERNS")).toBe(true)
  })

  it("accepts a verdict heading that appears after leading content", () => {
    expect(isReviewShaped("Now I have everything needed.\n\n## Verdict: FAIL")).toBe(true)
  })

  it("is case-insensitive on the `Verdict` keyword", () => {
    expect(isReviewShaped("## verdict: pass")).toBe(true)
  })

  it("rejects a plain `@kody2 fix` trigger", () => {
    expect(isReviewShaped("@kody2 fix")).toBe(false)
  })

  it("rejects a task-state block", () => {
    expect(isReviewShaped("<!-- kody2:state:v1:begin -->\n```json\n{}\n```")).toBe(false)
  })

  it("rejects a progress ping", () => {
    expect(isReviewShaped("👀 kody2 review started on PR #1, run …")).toBe(false)
  })

  it("rejects a status message", () => {
    expect(isReviewShaped("✅ kody2 pushed to https://github.com/x/y/pull/1")).toBe(false)
  })

  it("rejects a body that only mentions the word verdict in prose", () => {
    expect(isReviewShaped("Rendering the verdict in the UI")).toBe(false)
  })

  it("rejects an empty body", () => {
    expect(isReviewShaped("")).toBe(false)
  })
})
