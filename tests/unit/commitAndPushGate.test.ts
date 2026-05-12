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

  // Salvage path: when agentDone=false ONLY because the agent forgot to emit
  // the contract sentinel (markerMissing=true), the work itself is valid.
  // Pushing it lets ensurePr open a draft PR so the operator can inspect.
  // Without this, hours of agent work get discarded whenever a model drops
  // the DONE marker (see issue #1436).
  describe("salvage on missing marker", () => {
    it("commits and pushes when agentDone=false but agentMarkerMissing=true", async () => {
      vi.mocked(doCommitAndPush).mockClear()
      const ctx = makeCtx({ agentDone: false, agentMarkerMissing: true })
      await commitAndPush(ctx as never, profile, null)
      expect(doCommitAndPush).toHaveBeenCalledOnce()
      expect(ctx.data.salvagedFromMissingMarker).toBe(true)
    })

    it("uses the default commit message when no commitMessage was parsed", async () => {
      vi.mocked(doCommitAndPush).mockClear()
      const ctx = makeCtx({ agentDone: false, agentMarkerMissing: true })
      await commitAndPush(ctx as never, profile, null)
      const args = vi.mocked(doCommitAndPush).mock.calls[0]
      expect(args?.[1]).toBe("chore: kody changes")
    })

    it("still skips when agentDone=false and markerMissing is not set (e.g. requireFeedbackActions failure)", async () => {
      vi.mocked(doCommitAndPush).mockClear()
      const ctx = makeCtx({ agentDone: false })
      await commitAndPush(ctx as never, profile, null)
      expect(doCommitAndPush).not.toHaveBeenCalled()
      expect(ctx.data.salvagedFromMissingMarker).toBeUndefined()
    })

    it("still skips when agentDone=false and markerMissing=false (e.g. explicit FAILED)", async () => {
      vi.mocked(doCommitAndPush).mockClear()
      const ctx = makeCtx({ agentDone: false, agentMarkerMissing: false })
      await commitAndPush(ctx as never, profile, null)
      expect(doCommitAndPush).not.toHaveBeenCalled()
    })
  })
})

// Verify-gate: the verify postflight runs before commitAndPush in the
// pr-branch lifecycle chain. When it fails, the action is downgraded to
// *_FAILED but agentDone is left intact (the agent may have self-reported
// DONE). Pushing the agent's edits anyway pollutes the branch with broken
// commits that compound across retry attempts (see A-Guy issue #1592 where
// 4 failed runs left a growing pile of test files that subsequent attempts
// excused as "pre-existing").
describe("commitAndPush: gate on verifyOk", () => {
  it("skips commit when verifyOk is false, even with agentDone=true", async () => {
    vi.mocked(doCommitAndPush).mockClear()
    const ctx = makeCtx({ agentDone: true, verifyOk: false, commitMessage: "fix: x" })
    await commitAndPush(ctx as never, profile, null)
    expect(doCommitAndPush).not.toHaveBeenCalled()
    const res = ctx.data.commitResult as { committed: boolean; pushed: boolean; skippedReason?: string }
    expect(res.committed).toBe(false)
    expect(res.pushed).toBe(false)
    expect(res.skippedReason).toBe("verifyFailed")
  })

  it("proceeds when verifyOk is true", async () => {
    vi.mocked(doCommitAndPush).mockClear()
    const ctx = makeCtx({ agentDone: true, verifyOk: true, commitMessage: "fix: x" })
    await commitAndPush(ctx as never, profile, null)
    expect(doCommitAndPush).toHaveBeenCalledOnce()
  })

  it("proceeds when verifyOk is undefined (lifecycleConfig.verify=false skips the script)", async () => {
    vi.mocked(doCommitAndPush).mockClear()
    const ctx = makeCtx({ agentDone: true, commitMessage: "fix: x" })
    await commitAndPush(ctx as never, profile, null)
    expect(doCommitAndPush).toHaveBeenCalledOnce()
  })
})
