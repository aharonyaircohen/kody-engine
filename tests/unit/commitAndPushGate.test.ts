import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Stub commit.ts so the script doesn't shell out to git. Use the real
// isForbiddenPath (imported separately below) so the changedFiles filter
// test exercises the actual allow/deny logic.
vi.mock("../../src/commit.js", async () => {
  const real = await vi.importActual<typeof import("../../src/commit.js")>("../../src/commit.js")
  return {
    ...real,
    abortUnfinishedGitOps: () => [],
    commitAndPush: vi.fn(() => ({ committed: true, pushed: true })),
    hasCommitsAhead: () => false,
    listChangedFiles: vi.fn(() => []),
    listFilesInCommit: vi.fn(() => []),
  }
})

import { commitAndPush as doCommitAndPush } from "../../src/commit.js"
import { __resetRunIdCache } from "../../src/events.js"
import type { Profile } from "../../src/agent-actions/types.js"
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

// Push-failure branch: the commit landed but `git push` failed (network
// blip, branch protection, expired token). The postflight must surface
// this with exit code 4 + a `commitCrash` reason, so ensurePr bails
// (a missing-on-origin PR is worse than no PR at all) and postIssueComment
// can render a clear failure to the user.
describe("commitAndPush: push-failure branch", () => {
  it("sets exit code 4 + commitCrash when commit succeeded but push failed", async () => {
    vi.mocked(doCommitAndPush).mockClear()
    vi.mocked(doCommitAndPush).mockReturnValueOnce({
      committed: true,
      pushed: false,
      sha: "abc1234",
      message: "feat: x",
      pushError: "remote rejected: protected branch",
    })
    const ctx = makeCtx({ agentDone: true, commitMessage: "feat: x" })
    await commitAndPush(ctx as never, profile, null)
    expect(ctx.output.exitCode).toBe(4)
    expect(ctx.data.commitCrash).toMatch(/protected branch/)
    expect(ctx.output.reason).toMatch(/protected branch/)
  })

  it("never lowers a pre-existing non-zero exit code on push failure", async () => {
    // A verify failure already set exit=2; a subsequent push failure must
    // not silently downgrade it back to 4 (the postflight should leave
    // the higher-severity signal in place for the operator).
    vi.mocked(doCommitAndPush).mockClear()
    vi.mocked(doCommitAndPush).mockReturnValueOnce({
      committed: true,
      pushed: false,
      sha: "abc1234",
      message: "feat: x",
      pushError: "auth expired",
    })
    const ctx = makeCtx({ agentDone: true, commitMessage: "feat: x" })
    ctx.output.exitCode = 2
    await commitAndPush(ctx as never, profile, null)
    expect(ctx.output.exitCode).toBe(2)
  })
})

// Sentinel replay: on a re-entry within the same run (e.g. an accidentally
// double-wired postflight or a container retry), the script short-circuits
// and replays the prior result from disk instead of committing twice.
describe("commitAndPush: sentinel replay", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "commit-sentinel-"))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    __resetRunIdCache()
  })

  function makeCtxWithCwd(cwd: string, data: Record<string, unknown>) {
    return {
      args: {},
      cwd,
      config: { git: { defaultBranch: "main" } } as never,
      data: { branch: "feat-x", ...data } as Record<string, unknown>,
      output: { exitCode: 0 } as { exitCode: number; reason?: string; prUrl?: string },
      skipAgent: false,
    }
  }

  it("replays a previously-persisted commit result on second invocation", async () => {
    // Ensure a clean run-id cache so the env var we set below is the
    // one resolveRunId() returns (it caches the first computed value).
    __resetRunIdCache()
    process.env.KODY_RUN_ID = "test-run-sentinel"
    // First invocation: commits + writes the sentinel.
    vi.mocked(doCommitAndPush).mockClear()
    vi.mocked(doCommitAndPush).mockReturnValueOnce({
      committed: true,
      pushed: true,
      sha: "deadbee",
      message: "feat: y",
    })
    const ctx1 = makeCtxWithCwd(tmp, { agentDone: true, commitMessage: "feat: y" })
    await commitAndPush(ctx1 as never, { name: "fix" } as Profile, null)

    // Sentinel must have been written.
    const sentinel = path.join(tmp, ".kody", "agent-runs", "test-run-sentinel", "commit-fix.lock")
    expect(fs.existsSync(sentinel)).toBe(true)

    // Second invocation: the underlying commit must NOT be called again;
    // the result is replayed from disk. This is the bug class the sentinel
    // exists to prevent (a retried container step would otherwise double-commit).
    vi.mocked(doCommitAndPush).mockClear()
    const ctx2 = makeCtxWithCwd(tmp, { agentDone: true, commitMessage: "feat: y" })
    await commitAndPush(ctx2 as never, { name: "fix" } as Profile, null)
    expect(doCommitAndPush).not.toHaveBeenCalled()
    const res = ctx2.data.commitResult as { committed: boolean; pushed: boolean; sha?: string }
    expect(res.committed).toBe(true)
    expect(res.pushed).toBe(true)
    expect(res.sha).toBe("deadbee")
    expect(ctx2.data.commitIdempotencyReplay).toBe(true)
  })

  it("skips the sentinel machinery entirely when KODY_COMMIT_IDEMPOTENCY=0", async () => {
    __resetRunIdCache()
    process.env.KODY_RUN_ID = "test-run-no-sentinel"
    process.env.KODY_COMMIT_IDEMPOTENCY = "0"
    vi.mocked(doCommitAndPush).mockClear()
    const ctx = makeCtxWithCwd(tmp, { agentDone: true, commitMessage: "feat: z" })
    await commitAndPush(ctx as never, { name: "fix" } as Profile, null)
    // No sentinel must have been written when idempotency is disabled —
    // a future run should commit again, not replay an old result.
    const sentinel = path.join(tmp, ".kody", "agent-runs", "test-run-no-sentinel", "commit-fix.lock")
    expect(fs.existsSync(sentinel)).toBe(false)
  })
})

// changedFiles population: the postflight populates ctx.data.changedFiles
// from EITHER `listFilesInCommit("HEAD")` (after a successful commit) OR
// `listChangedFiles(cwd)` (when the commit was skipped — e.g. nothing
// allow-listed). The latter can contain forbidden paths (.env, .kody/*,
// kody.config.json) from the working tree; the filter strips them so a
// downstream script (verifyFixAlignment, postIssueComment) never reads a
// path it must never expose. The filter is a no-op on the success branch
// because commit.ts already un-staged every forbidden path before staging.
import { listChangedFiles, listFilesInCommit } from "../../src/commit.js"

describe("commitAndPush: changedFiles population", () => {
  beforeEach(() => {
    vi.mocked(doCommitAndPush).mockClear()
    vi.mocked(listChangedFiles).mockReset()
    vi.mocked(listFilesInCommit).mockReset()
  })

  it("uses listFilesInCommit (HEAD) on success — the commit pipeline already decontaminated", async () => {
    vi.mocked(doCommitAndPush).mockReturnValueOnce({
      committed: true,
      pushed: true,
      sha: "abc",
      message: "feat: x",
    })
    vi.mocked(listFilesInCommit).mockReturnValueOnce(["src/foo.ts", "README.md"])
    const ctx = makeCtx({ agentDone: true, commitMessage: "feat: x" })
    await commitAndPush(ctx as never, profile, null)
    expect(ctx.data.changedFiles).toEqual(["src/foo.ts", "README.md"])
    // listChangedFiles must not be called on the success path.
    expect(listChangedFiles).not.toHaveBeenCalled()
  })

  it("filters forbidden paths from the working-tree file list on commit failure", async () => {
    // When the commit was skipped (e.g. nothing allow-listed), the
    // postflight falls back to `git status`. The working tree can contain
    // .env, .kody/*, kody.config.json — the filter is the last line of
    // defense so a downstream consumer never reads a path it must never
    // expose.
    vi.mocked(doCommitAndPush).mockReturnValueOnce({
      committed: false,
      pushed: false,
      sha: "",
      message: "",
    })
    vi.mocked(listChangedFiles).mockReturnValueOnce(["src/foo.ts", ".env", "kody.config.json", ".kody/agent-runs/x.jsonl"])
    const ctx = makeCtx({ agentDone: true, commitMessage: "feat: x" })
    await commitAndPush(ctx as never, profile, null)
    expect(ctx.data.changedFiles).toEqual(["src/foo.ts"])
  })
})
