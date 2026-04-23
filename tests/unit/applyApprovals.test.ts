import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}))

vi.mock("../../src/issue.js", () => ({
  postIssueComment: vi.fn(),
  postPrReviewComment: vi.fn(),
}))

vi.mock("../../src/state.js", () => ({
  readTaskState: vi.fn(),
}))

import { execFileSync } from "node:child_process"
import type { Context, Profile } from "../../src/executables/types.js"
import { postIssueComment, postPrReviewComment } from "../../src/issue.js"
import { applyApprovals } from "../../src/scripts/applyApprovals.js"
import { readTaskState } from "../../src/state.js"

const emptyProfile = { name: "approve" } as Profile

function makeCtx(args: { issue?: number; pr?: number }): Context {
  return {
    args,
    cwd: "/tmp",
    config: {} as Context["config"],
    data: {},
    output: { exitCode: 0 },
  }
}

function stubState(overrides: { flow?: { name?: string; issueNumber?: number } }): void {
  vi.mocked(readTaskState).mockReturnValue({
    schemaVersion: 1,
    core: { phase: "idle", status: "succeeded", currentExecutable: null },
    attempts: {},
    history: [],
    ...overrides,
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  stubState({})
})

describe("applyApprovals", () => {
  it("refuses to run without --issue or --pr", async () => {
    const ctx = makeCtx({})
    await applyApprovals(ctx, emptyProfile, null)
    expect(ctx.output.exitCode).toBe(64)
    expect(postIssueComment).not.toHaveBeenCalled()
    expect(postPrReviewComment).not.toHaveBeenCalled()
  })

  it("posts confirmation on the issue when approved via issue", async () => {
    const ctx = makeCtx({ issue: 42 })
    await applyApprovals(ctx, emptyProfile, null)
    expect(postIssueComment).toHaveBeenCalledOnce()
    expect(postPrReviewComment).not.toHaveBeenCalled()
  })

  it("posts confirmation on the PR when approved via PR", async () => {
    stubState({ flow: { name: "bug", issueNumber: 99 } })
    const ctx = makeCtx({ pr: 123 })
    await applyApprovals(ctx, emptyProfile, null)
    expect(postPrReviewComment).toHaveBeenCalledOnce()
    expect(postIssueComment).not.toHaveBeenCalled()
  })

  it("re-triggers @kody2 <flow.name> on the issue when flow is known", async () => {
    stubState({ flow: { name: "feature", issueNumber: 77 } })
    const ctx = makeCtx({ issue: 77 })
    await applyApprovals(ctx, emptyProfile, null)
    const retrigger = vi
      .mocked(execFileSync)
      .mock.calls.find(
        (c) => c[0] === "gh" && Array.isArray(c[1]) && (c[1] as string[]).includes("@kody2 feature"),
      )
    expect(retrigger).toBeDefined()
    const args = retrigger?.[1] as string[]
    expect(args).toContain("issue")
    expect(args).toContain("comment")
    expect(args).toContain("77")
  })

  it("re-triggers the flow on the originating issue even when approve came from PR side", async () => {
    stubState({ flow: { name: "bug", issueNumber: 99 } })
    const ctx = makeCtx({ pr: 123 })
    await applyApprovals(ctx, emptyProfile, null)
    const retrigger = vi
      .mocked(execFileSync)
      .mock.calls.find(
        (c) => c[0] === "gh" && Array.isArray(c[1]) && (c[1] as string[]).includes("@kody2 bug"),
      )
    expect(retrigger).toBeDefined()
    expect(retrigger?.[1] as string[]).toContain("99") // issue number, not PR
  })

  it("does NOT re-trigger when no flow is in state", async () => {
    const ctx = makeCtx({ issue: 77 })
    await applyApprovals(ctx, emptyProfile, null)
    const retrigger = vi
      .mocked(execFileSync)
      .mock.calls.find((c) => c[0] === "gh" && Array.isArray(c[1]) && (c[1] as string[]).some((s) => s.startsWith("@kody2")))
    expect(retrigger).toBeUndefined()
  })
})
