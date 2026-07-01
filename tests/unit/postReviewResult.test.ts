import { describe, expect, it } from "vitest"
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
  it("parses a verdict heading followed by a standalone explicit verdict", () => {
    expect(detectVerdict("### Verdict\n\nPASS\n\nNo issues.")).toBe("PASS")
  })
  it("treats LGTM in a verdict section as PASS", () => {
    expect(
      detectVerdict("### Verdict\n\n**LGTM.** The implementation is correct, well-tested, and follows conventions."),
    ).toBe("PASS")
  })
  it("treats no changes required in a verdict section as PASS", () => {
    expect(detectVerdict("## Verdict\n\nThe implementation is correct. No changes required.")).toBe("PASS")
  })
  it("infers CONCERNS from an actionable review without a verdict heading", () => {
    expect(
      detectVerdict(
        [
          "### Summary",
          "",
          "Good PR. The main actionable item is clarifying in the docstring that unicode is preserved.",
        ].join("\n"),
      ),
    ).toBe("CONCERNS")
  })
  it("infers CONCERNS from a prose verdict that names an improvement opportunity", () => {
    expect(
      detectVerdict(
        [
          "### Verdict",
          "",
          "The change is factually correct and follows existing formatting.",
          "The improvement opportunity is that the new sentence would be more useful if paired with the command that runs integration tests.",
        ].join("\n"),
      ),
    ).toBe("CONCERNS")
  })
  it("infers FAIL from blocking review language without a verdict heading", () => {
    expect(detectVerdict("This introduces a regression and should not merge until fixed.")).toBe("FAIL")
  })
  it("infers PASS from a clean LGTM review without a verdict heading", () => {
    expect(detectVerdict("LGTM. The implementation is correct and no changes required.")).toBe("PASS")
  })
  it("returns UNKNOWN when no header present", () => {
    expect(detectVerdict("just a body, no verdict header")).toBe("UNKNOWN")
  })
  it("returns UNKNOWN for an invalid verdict value", () => {
    expect(detectVerdict("## Verdict: MAYBE")).toBe("UNKNOWN")
  })
  it("treats partial QA verdicts with findings as CONCERNS", () => {
    expect(detectVerdict('{"verdict":"partial","findings":[{"severity":"high"}]}')).toBe("CONCERNS")
    expect(detectVerdict("## Verdict\n\nPartial — 3 findings and 1 auth gap.")).toBe("CONCERNS")
  })
})
