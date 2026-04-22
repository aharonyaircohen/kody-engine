import { describe, expect, it } from "vitest"
import type { Profile } from "../../src/executables/types.js"
import {
  declinedFileRefs,
  extractReviewFileRefs,
  summarizeFeedbackActions,
  verifyFixAlignment,
} from "../../src/scripts/verifyFixAlignment.js"

const fixProfile = { name: "fix" } as Profile
const runProfile = { name: "run" } as Profile

function makeCtx(data: Record<string, unknown>) {
  return {
    args: {},
    cwd: "/x",
    config: {} as never,
    data,
    output: { exitCode: 0 } as { exitCode: number; reason?: string; prUrl?: string },
    skipAgent: false,
  }
}

describe("verifyFixAlignment: summarizeFeedbackActions", () => {
  it("counts fixed and declined items", () => {
    const block = ["- Item 1: fixed: moved cache", "- Item 2: declined: out of scope"].join("\n")
    expect(summarizeFeedbackActions(block)).toEqual({
      totalItems: 2,
      fixedItems: 1,
      declinedItems: 1,
      unparsedLines: 0,
    })
  })

  it("counts lines that are neither fixed nor declined as unparsed", () => {
    const block = "- Item 1: ambiguous thing"
    expect(summarizeFeedbackActions(block)).toEqual({
      totalItems: 1,
      fixedItems: 0,
      declinedItems: 0,
      unparsedLines: 1,
    })
  })

  it("returns zeros for empty input", () => {
    expect(summarizeFeedbackActions("")).toEqual({
      totalItems: 0,
      fixedItems: 0,
      declinedItems: 0,
      unparsedLines: 0,
    })
  })
})

describe("verifyFixAlignment postflight", () => {
  it("is a no-op on non-fix profiles", async () => {
    const ctx = makeCtx({ agentDone: true, feedbackActions: "", commitResult: { committed: false } })
    await verifyFixAlignment(ctx as never, runProfile, null)
    expect(ctx.data.action).toBeUndefined()
    expect(ctx.output.exitCode).toBe(0)
  })

  it("is a no-op when agent did not finish (parseAgentResult already failed)", async () => {
    const ctx = makeCtx({ agentDone: false })
    await verifyFixAlignment(ctx as never, fixProfile, null)
    expect(ctx.data.action).toBeUndefined()
  })

  it("accepts 'already fixed:' with no commit when no review file refs (idempotent re-run)", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedbackActions: "- Item 1: already fixed: prior commit addressed it",
      feedback: "### Concerns\n- prose concern without any file refs",
      commitResult: { committed: false },
    })
    await verifyFixAlignment(ctx as never, fixProfile, null)
    expect(ctx.data.agentDone).toBe(true)
    // upstream action (FIX_COMPLETED from parseAgentResult) stays
    expect(ctx.data.action).toBeUndefined()
  })

  it("fails with FIX_FAILED when FEEDBACK_ACTIONS has zero items", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedbackActions: "some prose, no bullets",
      commitResult: { committed: true },
    })
    await verifyFixAlignment(ctx as never, fixProfile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect((ctx.data.action as { type: string } | undefined)?.type).toBe("FIX_FAILED")
  })

  it("emits FIX_DECLINED (not FAILED) when all items are declined and no commit was made", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedbackActions: "- Item 1: declined: wrong about code",
      commitResult: { committed: false },
    })
    await verifyFixAlignment(ctx as never, fixProfile, null)
    expect(ctx.data.agentDone).toBe(true)
    expect((ctx.data.action as { type: string } | undefined)?.type).toBe("FIX_DECLINED")
    expect(ctx.output.exitCode).toBe(0)
  })

  it("passes through when fixed items match a real commit", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedbackActions: "- Item 1: fixed: moved cache\n- Item 2: fixed: ilike regex",
      commitResult: { committed: true },
    })
    await verifyFixAlignment(ctx as never, fixProfile, null)
    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.action).toBeUndefined()
  })

  it("fails when commit doesn't touch any file the review named", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedback: "### Concerns\n- bug at `src/services/foo.ts:12`\n- bug at `src/api/bar.ts:3`",
      feedbackActions: "- Item 1: fixed: refactored unrelated helper",
      commitResult: { committed: true },
      changedFiles: ["src/utils/helper.ts"],
    })
    await verifyFixAlignment(ctx as never, fixProfile, null)
    expect(ctx.data.agentDone).toBe(false)
    expect((ctx.data.action as { type: string } | undefined)?.type).toBe("FIX_FAILED")
    expect(String(ctx.output.reason)).toMatch(/src\/services\/foo\.ts/)
    expect(String(ctx.output.reason)).toMatch(/src\/api\/bar\.ts/)
  })

  it("passes when commit touches every review-named file", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedback: "### Concerns\n- bug at `src/services/foo.ts:12`",
      feedbackActions: "- Item 1: fixed: addressed foo.ts:12",
      commitResult: { committed: true },
      changedFiles: ["src/services/foo.ts"],
    })
    await verifyFixAlignment(ctx as never, fixProfile, null)
    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.action).toBeUndefined()
  })

  it("passes when a review-named file is explicitly declined even if not touched", async () => {
    const ctx = makeCtx({
      agentDone: true,
      feedback: "### Concerns\n- bug at `src/services/foo.ts:12`\n- bug at `src/api/bar.ts:3`",
      feedbackActions:
        "- Item 1: fixed: touched foo.ts\n- Item 2: declined: src/api/bar.ts:3 is out-of-scope per issue body",
      commitResult: { committed: true },
      changedFiles: ["src/services/foo.ts"],
    })
    await verifyFixAlignment(ctx as never, fixProfile, null)
    expect(ctx.data.agentDone).toBe(true)
    expect(ctx.data.action).toBeUndefined()
  })
})

describe("verifyFixAlignment: extractReviewFileRefs", () => {
  it("pulls backticked code-file refs from actionable sections (deduped)", () => {
    const body = [
      "### Concerns",
      "- issue at `src/services/foo.ts:12`",
      "- issue at `src/services/foo.ts:40`",
      "### Suggestions",
      "- fix `src/api/bar.ts`",
      "- link to https://example.com/baz.ts",
    ].join("\n")
    expect(extractReviewFileRefs(body).sort()).toEqual(["src/api/bar.ts", "src/services/foo.ts"])
  })

  it("pulls bare-text paths from actionable sections too", () => {
    const body = "### Concerns\n- issue at src/utils/thing.ts:55 has a problem"
    expect(extractReviewFileRefs(body)).toContain("src/utils/thing.ts")
  })

  it("ignores paths mentioned in non-actionable sections (Strengths, Summary)", () => {
    const body = [
      "### Summary",
      "Nice work on `src/utils/a.ts`.",
      "### Strengths",
      "- `src/utils/b.ts:5` is elegant.",
      "### Concerns",
      "- `src/utils/c.ts:10` has a bug.",
    ].join("\n")
    expect(extractReviewFileRefs(body)).toEqual(["src/utils/c.ts"])
  })

  it("ignores doc / image / pdf extensions", () => {
    const body = "### Suggestions\n- see `docs/readme.md` and `logo.png`"
    expect(extractReviewFileRefs(body)).toEqual([])
  })

  it("ignores bare filenames without a directory", () => {
    const body = "### Concerns\n- fix the `foo.ts` helper"
    expect(extractReviewFileRefs(body)).toEqual([])
  })

  it("returns [] for empty body", () => {
    expect(extractReviewFileRefs("")).toEqual([])
  })

  it("returns [] when there are no actionable headings", () => {
    const body = "### Summary\nAll good.\n### Strengths\n- `src/foo.ts:1` is great."
    expect(extractReviewFileRefs(body)).toEqual([])
  })
})

describe("verifyFixAlignment: declinedFileRefs", () => {
  it("returns refs mentioned in declined: lines", () => {
    const block = "- Item 1: declined: src/a.ts is fine\n- Item 2: fixed: patched src/b.ts"
    const refs = ["src/a.ts", "src/b.ts"]
    expect([...declinedFileRefs(block, refs)]).toEqual(["src/a.ts"])
  })

  it("ignores fixed: lines", () => {
    const block = "- Item 1: fixed: src/a.ts"
    expect([...declinedFileRefs(block, ["src/a.ts"])]).toEqual([])
  })

  it("returns empty for empty block or empty refs", () => {
    expect([...declinedFileRefs("", ["src/a.ts"])]).toEqual([])
    expect([...declinedFileRefs("- declined: anything", [])]).toEqual([])
  })
})
