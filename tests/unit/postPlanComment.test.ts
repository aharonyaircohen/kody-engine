import { describe, expect, it } from "vitest"
import { renderPlanComment } from "../../src/scripts/postPlanComment.js"

describe("postPlanComment: renderPlanComment", () => {
  it("prefixes the plan body with a titled heading", () => {
    const out = renderPlanComment(42, "## Files to change\n- foo.ts")
    expect(out.startsWith("## Plan for issue #42\n\n## Files to change")).toBe(true)
  })

  it("appends a footer pointing to @kody2 run", () => {
    const out = renderPlanComment(7, "body")
    expect(out).toContain("Comment `@kody2 run` to execute this plan.")
  })

  it("preserves the plan body verbatim", () => {
    const plan = "line1\nline2\n- item\n```ts\nx\n```"
    const out = renderPlanComment(1, plan)
    expect(out).toContain(plan)
  })
})
