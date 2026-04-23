import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/branch.js", () => ({
  checkoutPrBranch: vi.fn(),
  getCurrentBranch: vi.fn(() => "feature-branch"),
  mergeBase: vi.fn(),
}))
vi.mock("../../src/issue.js", () => ({
  getPr: vi.fn(),
  postPrReviewComment: vi.fn(),
}))
vi.mock("../../src/gha.js", () => ({
  getRunUrl: vi.fn(() => ""),
}))

const execFileSyncMock = vi.fn()
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}))

import { mergeBase } from "../../src/branch.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { getPr, postPrReviewComment } from "../../src/issue.js"
import { syncFlow } from "../../src/scripts/syncFlow.js"

const profile = {} as Profile

function makeCtx(): Context {
  return {
    args: { pr: 42 },
    cwd: "/tmp",
    config: { git: { defaultBranch: "main" } } as Context["config"],
    data: {},
    output: { exitCode: 0 },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  execFileSyncMock.mockReset()
  vi.mocked(getPr).mockReturnValue({ state: "OPEN", number: 42, baseRefName: "main" } as never)
})

describe("syncFlow", () => {
  it("posts 'already up to date' when merge is a no-op", async () => {
    vi.mocked(mergeBase).mockReturnValue("clean")
    // Two rev-parse HEAD calls: before + after merge. Return the same SHA both times.
    execFileSyncMock.mockReturnValue("abc123\n")

    const ctx = makeCtx()
    await syncFlow(ctx, profile)

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.output.reason).toMatch(/already up to date/)
    expect(postPrReviewComment).toHaveBeenCalledTimes(1)
    expect(vi.mocked(postPrReviewComment).mock.calls[0]![1]).toMatch(/already up to date with origin\/main/)
  })

  it("pushes and posts success when merge advances HEAD", async () => {
    vi.mocked(mergeBase).mockReturnValue("clean")
    // rev-parse before, rev-parse after (different SHAs), then git push succeeds.
    execFileSyncMock.mockReturnValueOnce("abc123\n").mockReturnValueOnce("def456\n").mockReturnValueOnce("") // push

    const ctx = makeCtx()
    await syncFlow(ctx, profile)

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.output.reason).toMatch(/merged origin\/main/)
    // Verify a push was invoked.
    const pushCall = execFileSyncMock.mock.calls.find((c) => (c[1] as string[]).includes("push"))
    expect(pushCall).toBeTruthy()
    expect(vi.mocked(postPrReviewComment).mock.calls[0]![1]).toMatch(/✅ kody sync/)
  })

  it("bails and tells user to run resolve on conflict", async () => {
    vi.mocked(mergeBase).mockReturnValue("conflict")
    execFileSyncMock.mockReturnValue("abc123\n")

    const ctx = makeCtx()
    await syncFlow(ctx, profile)

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toMatch(/conflicts/)
    expect(vi.mocked(postPrReviewComment).mock.calls[0]![1]).toMatch(/@kody resolve/)
  })

  it("bails on merge error", async () => {
    vi.mocked(mergeBase).mockReturnValue("error")
    execFileSyncMock.mockReturnValue("abc123\n")

    const ctx = makeCtx()
    await syncFlow(ctx, profile)

    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toMatch(/non-conflict error/)
    expect(vi.mocked(postPrReviewComment).mock.calls[0]![1]).toMatch(/❌ kody sync/)
  })

  it("bails when PR is not OPEN", async () => {
    vi.mocked(getPr).mockReturnValue({ state: "CLOSED", number: 42 } as never)
    const ctx = makeCtx()

    await syncFlow(ctx, profile)

    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toMatch(/is not OPEN/)
  })
})
