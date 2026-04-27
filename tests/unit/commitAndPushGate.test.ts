import { describe, expect, it, vi } from "vitest"

// Stub commit.ts so the script doesn't shell out to git.
vi.mock("../../src/commit.js", () => ({
  abortUnfinishedGitOps: () => [],
  commitAndPush: vi.fn(() => ({ committed: true, pushed: true })),
  hasCommitsAhead: () => false,
  isForbiddenPath: () => false,
  listChangedFiles: () => [],
  listFilesInCommit: () => [],
}))

import { commitAndPush as doCommitAndPush } from "../../src/commit.js"
import type { Profile } from "../../src/executables/types.js"
import { commitAndPush } from "../../src/scripts/commitAndPush.js"

const profile = { name: "fix" } as Profile

function makeCtx(data: Record<string, unknown>) {
  return {
    args: {},
    cwd: "/x",
    config: { git: { defaultBranch: "main" } } as never,
    data: { branch: "feat-x", ...data } as Record<string, unknown>,
    output: { exitCode: 0 } as { exitCode: number; reason?: string; prUrl?: string },
    skipAgent: false,
  }
}

describe("commitAndPush: gate on agentDone", () => {
  it("skips commit when agentDone is false", async () => {
    vi.mocked(doCommitAndPush).mockClear()
    const ctx = makeCtx({ agentDone: false })
    await commitAndPush(ctx as never, profile, null)
    expect(doCommitAndPush).not.toHaveBeenCalled()
    const res = ctx.data.commitResult as { committed: boolean; pushed: boolean; skippedReason?: string }
    expect(res.committed).toBe(false)
    expect(res.pushed).toBe(false)
    expect(res.skippedReason).toBe("agentDone=false")
  })

  it("proceeds to commit when agentDone is true", async () => {
    vi.mocked(doCommitAndPush).mockClear()
    const ctx = makeCtx({ agentDone: true, commitMessage: "fix: x" })
    await commitAndPush(ctx as never, profile, null)
    expect(doCommitAndPush).toHaveBeenCalledOnce()
    expect((ctx.data.commitResult as { committed: boolean }).committed).toBe(true)
  })

  it("proceeds when agentDone is undefined (legacy profiles without the flag)", async () => {
    vi.mocked(doCommitAndPush).mockClear()
    const ctx = makeCtx({ commitMessage: "fix: x" })
    await commitAndPush(ctx as never, profile, null)
    expect(doCommitAndPush).toHaveBeenCalledOnce()
  })
})
