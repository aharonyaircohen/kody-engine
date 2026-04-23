import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}))

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(() => ""),
  postIssueComment: vi.fn(),
  postPrReviewComment: vi.fn(),
}))

vi.mock("../../src/state.js", () => ({
  readTaskState: vi.fn(),
}))

import { execFileSync } from "node:child_process"
import type { Context, Profile } from "../../src/executables/types.js"
import { gh, postIssueComment, postPrReviewComment } from "../../src/issue.js"
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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readTaskState).mockReturnValue({
    schemaVersion: 1,
    core: { phase: "idle", status: "succeeded", currentExecutable: null },
    attempts: {},
    history: [],
  } as never)
})

describe("applyApprovals: target resolution", () => {
  it("refuses to run without --issue or --pr", async () => {
    const ctx = makeCtx({})
    await applyApprovals(ctx, emptyProfile, null)
    expect(ctx.output.exitCode).toBe(64)
    expect(gh).not.toHaveBeenCalled()
  })

  it("applies labels to the issue when invoked with --issue", async () => {
    vi.mocked(readTaskState).mockReturnValue({
      schemaVersion: 1,
      core: { phase: "idle", status: "succeeded", currentExecutable: null },
      attempts: {},
      history: [],
    } as never)
    const ctx = makeCtx({ issue: 42 })
    await applyApprovals(ctx, emptyProfile, null)
    const addLabelCalls = vi
      .mocked(gh)
      .mock.calls.filter((c) => c[0][0] === "issue" && c[0][1] === "edit" && c[0][3] === "--add-label")
    expect(addLabelCalls.length).toBeGreaterThanOrEqual(6) // all + 5 gates
    for (const c of addLabelCalls) {
      expect(c[0][2]).toBe("42")
      expect(String(c[0][4])).toMatch(/^kody-approve:/)
    }
  })

  it("mirrors labels to PR when invoked on issue with prUrl in state", async () => {
    vi.mocked(readTaskState).mockReturnValue({
      schemaVersion: 1,
      core: {
        phase: "idle",
        status: "succeeded",
        currentExecutable: null,
        prUrl: "https://github.com/o/r/pull/123",
      },
      attempts: {},
      history: [],
    } as never)
    const ctx = makeCtx({ issue: 42 })
    await applyApprovals(ctx, emptyProfile, null)
    const addLabelCalls = vi
      .mocked(gh)
      .mock.calls.filter((c) => c[0][0] === "issue" && c[0][1] === "edit" && c[0][3] === "--add-label")
    const targets = new Set(addLabelCalls.map((c) => c[0][2]))
    expect(targets.has("42")).toBe(true)
    expect(targets.has("123")).toBe(true)
  })

  it("mirrors labels to issue when invoked on PR with flow.issueNumber in state", async () => {
    vi.mocked(readTaskState).mockReturnValue({
      schemaVersion: 1,
      core: { phase: "idle", status: "succeeded", currentExecutable: null },
      attempts: {},
      history: [],
      flow: { name: "bug", issueNumber: 99, step: "run" },
    } as never)
    const ctx = makeCtx({ pr: 123 })
    await applyApprovals(ctx, emptyProfile, null)
    const addLabelCalls = vi
      .mocked(gh)
      .mock.calls.filter((c) => c[0][0] === "issue" && c[0][1] === "edit" && c[0][3] === "--add-label")
    const targets = new Set(addLabelCalls.map((c) => c[0][2]))
    expect(targets.has("123")).toBe(true)
    expect(targets.has("99")).toBe(true)
  })
})

describe("applyApprovals: re-trigger", () => {
  it("posts @kody2 <flow.name> on the issue when flow is known", async () => {
    vi.mocked(readTaskState).mockReturnValue({
      schemaVersion: 1,
      core: { phase: "idle", status: "succeeded", currentExecutable: null },
      attempts: {},
      history: [],
      flow: { name: "feature", issueNumber: 77, step: "run" },
    } as never)
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

  it("does NOT re-trigger when no flow is known", async () => {
    vi.mocked(readTaskState).mockReturnValue({
      schemaVersion: 1,
      core: { phase: "idle", status: "succeeded", currentExecutable: null },
      attempts: {},
      history: [],
    } as never)
    const ctx = makeCtx({ issue: 77 })
    await applyApprovals(ctx, emptyProfile, null)
    const retrigger = vi
      .mocked(execFileSync)
      .mock.calls.find((c) => c[0] === "gh" && Array.isArray(c[1]) && (c[1] as string[]).some((s) => s.startsWith("@kody2")))
    expect(retrigger).toBeUndefined()
  })
})

describe("applyApprovals: confirmation comment", () => {
  it("posts confirmation on the issue when approved via issue", async () => {
    const ctx = makeCtx({ issue: 42 })
    await applyApprovals(ctx, emptyProfile, null)
    expect(postIssueComment).toHaveBeenCalledOnce()
    expect(postPrReviewComment).not.toHaveBeenCalled()
  })

  it("posts confirmation on the PR when approved via PR", async () => {
    const ctx = makeCtx({ pr: 123 })
    await applyApprovals(ctx, emptyProfile, null)
    expect(postPrReviewComment).toHaveBeenCalledOnce()
    expect(postIssueComment).not.toHaveBeenCalled()
  })
})

describe("applyApprovals: label creation", () => {
  it("ensures all approve labels exist in the repo", async () => {
    const ctx = makeCtx({ issue: 42 })
    await applyApprovals(ctx, emptyProfile, null)
    const createCalls = vi.mocked(gh).mock.calls.filter((c) => c[0][0] === "label" && c[0][1] === "create")
    const labels = createCalls.map((c) => c[0][2])
    expect(labels).toContain("kody-approve:all")
    expect(labels).toContain("kody-approve:secrets")
    expect(labels).toContain("kody-approve:workflow-edit")
    expect(labels).toContain("kody-approve:large-diff")
    expect(labels).toContain("kody-approve:dep-change")
    expect(labels).toContain("kody-approve:test-deletion")
  })
})
