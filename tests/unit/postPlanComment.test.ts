import { describe, expect, it } from "vitest"
import { renderPlanComment } from "../../src/scripts/postPlanComment.js"

describe("postPlanComment: renderPlanComment", () => {
  it("prefixes the plan body with a titled heading", () => {
    const out = renderPlanComment(42, "## Files to change\n- foo.ts")
    expect(out.startsWith("## Plan for issue #42\n\n## Files to change")).toBe(true)
  })

  it("standalone (no flow): footer instructs the human but never embeds a literal @kody trigger", () => {
    const out = renderPlanComment(7, "body")
    expect(out).toContain("kody run")
    // The literal '@kody' must NOT appear — GHA's contains() filter would
    // otherwise re-fire this very workflow.
    expect(out).not.toMatch(/@kody/)
  })

  it("inside a flow: footer points to the orchestrator, not a manual trigger", () => {
    const out = renderPlanComment(7, "body", { flowActive: true })
    expect(out).toContain("Orchestrator will advance")
    expect(out).not.toMatch(/@kody/)
    expect(out).not.toMatch(/kody run/)
  })

  it("preserves the plan body verbatim", () => {
    const plan = "line1\nline2\n- item\n```ts\nx\n```"
    const out = renderPlanComment(1, plan)
    expect(out).toContain(plan)
  })
})
