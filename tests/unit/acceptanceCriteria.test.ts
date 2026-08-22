import { describe, expect, it } from "vitest"
import { extractAcceptanceCriteria, formatAcceptanceCriteria } from "../../src/acceptanceCriteria.js"

describe("acceptance criteria", () => {
  it("numbers explicit acceptance bullets and stops at the next section", () => {
    const criteria = extractAcceptanceCriteria(
      [
        "## Context",
        "Build the feature.",
        "## Acceptance criteria",
        "- [ ] old records survive",
        "- learners see only their own data",
        "## Notes",
        "- this is not a criterion",
      ].join("\n"),
    )

    expect(criteria).toEqual([
      { id: "A1", text: "old records survive" },
      { id: "A2", text: "learners see only their own data" },
    ])
    expect(formatAcceptanceCriteria(criteria)).toContain("A2: learners see only their own data")
  })

  it("does not invent criteria when no acceptance section exists", () => {
    expect(extractAcceptanceCriteria("## Notes\n- ordinary context")).toEqual([])
  })
})
