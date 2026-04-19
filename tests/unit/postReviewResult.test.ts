import { describe, it, expect } from "vitest"
import { detectVerdict } from "../../src/scripts/postReviewResult.js"

describe("postReviewResult: detectVerdict", () => {
  it("parses PASS", () => {
    expect(detectVerdict("## Verdict: PASS\n\n...")).toBe("PASS")
  })
  it("parses CONCERNS", () => {
    expect(detectVerdict("## Verdict: CONCERNS\n\n...")).toBe("CONCERNS")
  })
  it("parses FAIL", () => {
    expect(detectVerdict("## Verdict: FAIL")).toBe("FAIL")
  })
  it("is case-insensitive", () => {
    expect(detectVerdict("## verdict: pass")).toBe("PASS")
  })
  it("tolerates whitespace around the colon", () => {
    expect(detectVerdict("## Verdict   :   CONCERNS")).toBe("CONCERNS")
  })
  it("returns UNKNOWN when no header present", () => {
    expect(detectVerdict("just a body, no verdict header")).toBe("UNKNOWN")
  })
  it("returns UNKNOWN for an invalid verdict value", () => {
    expect(detectVerdict("## Verdict: MAYBE")).toBe("UNKNOWN")
  })
})
