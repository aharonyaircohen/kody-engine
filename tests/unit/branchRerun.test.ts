import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import { cleanupExistingBranchForRerun, ensureFeatureBranch } from "../../src/branch.js"
import { gh } from "../../src/issue.js"

/**
 * Unit tests for the rerun cleanup path added in #39: a second `run` on
 * the same issue must close any open PR for the branch, delete the
 * remote + local branch refs, and let `ensureFeatureBranch` fork a fresh
 * branch from `origin/<default>`. The local side of this is exercised
 * against a real temp repo (no `gh` mocked here); the `gh` side is
 * exercised in `branchRerunGh.test.ts`.
 */

interface TempRepo {
  workdir: string
  remote: string
  cleanup: () => void
}

const GIT_ENV = {
  ...process.env,
  HUSKY: "0",
  SKIP_HOOKS: "1",
  GIT_AUTHOR_NAME: "Kody Test",
  GIT_AUTHOR_EMAIL: "test@kody",
  GIT_COMMITTER_NAME: "Kody Test",
  GIT_COMMITTER_EMAIL: "test@kody",
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    cwd,
    env: GIT_ENV,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

function makeRepo(): TempRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-rerun-"))
  const remote = path.join(root, "remote.git")
  const workdir = path.join(root, "work")
  fs.mkdirSync(workdir, { recursive: true })
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "pipe" })
  execFileSync("git", ["init", "--initial-branch=main", workdir], { stdio: "pipe" })
  git(workdir, ["remote", "add", "origin", remote])
  fs.writeFileSync(path.join(workdir, "README.md"), "# initial\n")
  git(workdir, ["add", "."])
  git(workdir, ["commit", "--no-gpg-sign", "-m", "initial"])
  git(workdir, ["push", "-u", "origin", "main"])
  return {
    workdir,
    remote,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    },
  }
}

describe("cleanupExistingBranchForRerun (local branch side)", () => {
  let repo: TempRepo

  beforeEach(() => {
    repo = makeRepo()
    vi.mocked(gh).mockReset()
  })
  afterEach(() => repo.cleanup())

  it("deletes the local and remote branch refs", () => {
    // ensureFeatureBranch forks the branch locally; in real usage the
    // agent's commitAndPush pushes it to origin before the next run
    // arrives. Mirror that here so the remote ref exists for cleanup to
    // delete.
    const branch = "7-rerun-local"
    ensureFeatureBranch(7, "rerun local", "main", repo.workdir)
    git(repo.workdir, ["push", "-u", "origin", branch])
    expect(git(repo.workdir, ["rev-parse", "--verify", `refs/heads/${branch}`])).toBeTruthy()
    expect(git(repo.workdir, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`])).toBeTruthy()

    const result = cleanupExistingBranchForRerun(branch, repo.workdir)

    expect(result.remoteBranchDeleted).toBe(true)
    expect(result.localBranchDeleted).toBe(true)
    // The local branch is gone — `git rev-parse --verify refs/heads/...` errors.
    expect(() => git(repo.workdir, ["rev-parse", "--verify", `refs/heads/${branch}`])).toThrow()
    // The remote tracking ref is also gone.
    expect(() => git(repo.workdir, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`])).toThrow()
  })

  it("is a no-op when the branch is already gone (ignore not-found)", () => {
    const result = cleanupExistingBranchForRerun("ghost-branch", repo.workdir)
    expect(result.remoteBranchDeleted).toBe(false)
    expect(result.localBranchDeleted).toBe(false)
    // Best-effort gh call may still happen (empty list), but must not throw.
    expect(() => cleanupExistingBranchForRerun("ghost-branch", repo.workdir)).not.toThrow()
  })

  it("survives a `gh` failure (no auth / no network) and still deletes the local branch", () => {
    const branch = "11-gh-broken"
    ensureFeatureBranch(11, "gh broken", "main", repo.workdir)
    git(repo.workdir, ["push", "-u", "origin", branch])
    // Simulate `gh` being unavailable: every call throws.
    vi.mocked(gh).mockImplementation(() => {
      throw new Error("gh: command not found")
    })

    const result = cleanupExistingBranchForRerun(branch, repo.workdir)

    expect(result.remoteBranchDeleted).toBe(true)
    expect(result.localBranchDeleted).toBe(true)
    expect(() => git(repo.workdir, ["rev-parse", "--verify", `refs/heads/${branch}`])).toThrow()
  })

  it("after cleanup, ensureFeatureBranch forks fresh from origin/<default>", () => {
    // First call creates the branch; we push a commit so the branch tip
    // diverges from main. The rerun path must NOT keep that commit.
    const branch = "13-fresh-after-rerun"
    const first = ensureFeatureBranch(13, "fresh after rerun", "main", repo.workdir)
    expect(first.created).toBe(true)
    fs.writeFileSync(path.join(repo.workdir, "drift.txt"), "stale work from prior run\n")
    git(repo.workdir, ["add", "drift.txt"])
    git(repo.workdir, ["commit", "--no-gpg-sign", "-m", "drift"])
    git(repo.workdir, ["push", "origin", branch])
    // Confirm the drift commit is on the remote branch.
    expect(git(repo.workdir, ["ls-remote", "origin", branch])).toMatch(/[0-9a-f]{40}/)
    const driftTip = git(repo.workdir, ["rev-parse", `origin/${branch}`])
    const defaultTipBefore = git(repo.workdir, ["rev-parse", "origin/main"])
    expect(driftTip).not.toBe(defaultTipBefore)

    // Switch back to main, then re-run the same issue. Cleanup + recreate
    // must leave us on a branch whose tip equals origin/main, with no
    // trace of the drift commit. (The remote ref is deleted by cleanup
    // and not re-pushed by ensureFeatureBranch — we compare the new local
    // branch tip to origin/main via the working tree's HEAD.)
    git(repo.workdir, ["checkout", "main"])
    const second = ensureFeatureBranch(13, "fresh after rerun", "main", repo.workdir)
    expect(second.created).toBe(true)
    // Working tree must NOT contain the drift file from the prior run —
    // the branch is forked fresh from origin/main.
    expect(fs.existsSync(path.join(repo.workdir, "drift.txt"))).toBe(false)
    // The new local branch tip equals origin/main (no drift).
    const newBranchTip = git(repo.workdir, ["rev-parse", branch])
    const defaultTipAfter = git(repo.workdir, ["rev-parse", "origin/main"])
    expect(newBranchTip).toBe(defaultTipAfter)
  })
})

describe("cleanupExistingBranchForRerun (gh PR-close side, mocked)", () => {
  beforeEach(() => {
    vi.mocked(gh).mockReset()
  })

  it("lists open PRs by head, closes each with 'Superseded by rerun.', and reports the count", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([{ number: 101 }, { number: 102 }])
      }
      if (args[0] === "pr" && args[1] === "close") {
        return ""
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    const result = cleanupExistingBranchForRerun("any-branch")
    expect(result.closedPrs).toBe(2)
    const closeCalls = vi.mocked(gh).mock.calls.filter(([args]) => args[0] === "pr" && args[1] === "close")
    expect(closeCalls).toHaveLength(2)
    // Each close uses the fixed comment and --delete-branch (the `--delete-branch`
    // flag on `gh pr close` both closes and deletes the branch atomically).
    for (const [closeArgs] of closeCalls) {
      expect(closeArgs).toContain("Superseded by rerun.")
      expect(closeArgs).toContain("--delete-branch")
    }
  })

  it("survives a per-PR close failure and continues to the next one", () => {
    let closeCount = 0
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([{ number: 1 }, { number: 2 }])
      }
      if (args[0] === "pr" && args[1] === "close") {
        closeCount++
        if (closeCount === 1) throw new Error("network blip")
        return ""
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    const result = cleanupExistingBranchForRerun("any-branch")
    expect(result.closedPrs).toBe(1)
    expect(closeCount).toBe(2)
  })

  it("returns closedPrs=0 when `gh pr list` reports no open PRs", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") return "[]"
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    const result = cleanupExistingBranchForRerun("any-branch")
    expect(result.closedPrs).toBe(0)
  })
})
