import { describe, expect, it } from "vitest"
import { parsePrNumber } from "../../src/scripts/mirrorStateToPr.js"

describe("mirrorStateToPr: parsePrNumber", () => {
  it("extracts the PR number from a canonical PR URL", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/42")).toBe(42)
  })

  it("handles trailing slash", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/123/")).toBe(123)
  })

  it("handles a query string after the number", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/7?diff=split")).toBe(7)
  })

  it("handles a fragment after the number", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/9#issuecomment-1")).toBe(9)
  })

  it("returns null for an issue URL (not a PR)", () => {
    expect(parsePrNumber("https://github.com/owner/repo/issues/42")).toBeNull()
  })

  it("returns null for non-GitHub strings", () => {
    expect(parsePrNumber("not a url")).toBeNull()
    expect(parsePrNumber("")).toBeNull()
  })

  it("does not match a digit-prefixed garbage segment", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pulls/42")).toBeNull()
  })
})
