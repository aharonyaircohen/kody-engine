import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  postIssueComment: vi.fn(),
  postPrReviewComment: vi.fn(),
  truncate: (s: string) => s,
}))

import type { Context, Profile } from "../../src/executables/types.js"
import {
  postIssueComment as ghPostIssueComment,
  postPrReviewComment as ghPostPrReviewComment,
} from "../../src/issue.js"
import { postIssueComment } from "../../src/scripts/postIssueComment.js"

const profile = {} as Profile

function makeCtx(overrides: {
  commitResult?: { committed: boolean }
  hasCommitsAhead?: boolean
  prUrl?: string
  prAction?: "created" | "updated"
  agentDone?: boolean
  verifyOk?: boolean
  verifyReason?: string
  target?: "issue" | "pr"
  targetNumber?: number
}): Context {
  const {
    commitResult = { committed: true },
    hasCommitsAhead = true,
    prUrl = "https://github.com/x/y/pull/42",
    prAction = "created",
    agentDone = true,
    verifyOk = true,
    verifyReason,
    target = "pr",
    targetNumber = 42,
  } = overrides

  return {
    args: {},
    cwd: "/tmp",
    config: {} as Context["config"],
    data: {
      commentTargetType: target,
      commentTargetNumber: targetNumber,
      commitResult,
      hasCommitsAhead,
      prResult: { action: prAction, url: prUrl, number: targetNumber, draft: false },
      agentDone,
      verifyOk,
      ...(verifyReason ? { verifyReason } : {}),
    },
    output: { exitCode: 0, prUrl },
  }
}

function lastPrBody(): string {
  const call = vi.mocked(ghPostPrReviewComment).mock.calls.at(-1)
  return String(call?.[1] ?? "")
}

describe("postIssueComment message wording", () => {
  beforeEach(() => {
    vi.mocked(ghPostIssueComment).mockClear()
    vi.mocked(ghPostPrReviewComment).mockClear()
  })

  it("success + newly-created PR: says 'PR opened'", async () => {
    const ctx = makeCtx({ prAction: "created" })
    await postIssueComment(ctx, profile, null)
    expect(lastPrBody()).toBe("✅ kody PR opened: https://github.com/x/y/pull/42")
  })

  it("success + existing PR (updated): says 'pushed to' — not 'PR opened'", async () => {
    const ctx = makeCtx({ prAction: "updated" })
    await postIssueComment(ctx, profile, null)
    const body = lastPrBody()
    expect(body).toBe("✅ kody pushed to https://github.com/x/y/pull/42")
    expect(body).not.toContain("PR opened")
  })

  it("failure + created PR: uses 'draft PR' suffix", async () => {
    const ctx = makeCtx({
      prAction: "created",
      verifyOk: false,
      verifyReason: "typecheck failed",
    })
    await postIssueComment(ctx, profile, null)
    expect(lastPrBody()).toBe("⚠️ kody FAILED: typecheck failed — draft PR: https://github.com/x/y/pull/42")
  })

  it("failure + updated PR: uses plain 'PR' suffix (not 'draft PR')", async () => {
    const ctx = makeCtx({
      prAction: "updated",
      verifyOk: false,
      verifyReason: "typecheck failed",
    })
    await postIssueComment(ctx, profile, null)
    const body = lastPrBody()
    expect(body).toBe("⚠️ kody FAILED: typecheck failed — PR: https://github.com/x/y/pull/42")
    expect(body).not.toContain("draft PR")
  })

  it("no commits: posts 'no changes to commit' regardless of prAction", async () => {
    const ctx = makeCtx({
      commitResult: { committed: false },
      hasCommitsAhead: false,
      prAction: "updated",
    })
    await postIssueComment(ctx, profile, null)
    expect(lastPrBody()).toBe("⚠️ kody FAILED: no changes to commit")
    expect(ctx.output.exitCode).toBe(3)
  })

  // Regression: previously any rerun on an existing PR said "pushed to" even
  // when the current run made no new commit (only pre-existing commits were
  // ahead). That masked no-op fix runs. See issue #4.
  it("existing PR + this run made no commit: says 'no changes' — not 'pushed to'", async () => {
    const ctx = makeCtx({
      commitResult: { committed: false },
      hasCommitsAhead: true,
      prAction: "updated",
    })
    await postIssueComment(ctx, profile, null)
    const body = lastPrBody()
    expect(body).toContain("no changes")
    expect(body).toContain("https://github.com/x/y/pull/42")
    expect(body).not.toContain("pushed to")
  })

  it("existing PR + this run committed: still says 'pushed to'", async () => {
    const ctx = makeCtx({
      commitResult: { committed: true },
      hasCommitsAhead: true,
      prAction: "updated",
    })
    await postIssueComment(ctx, profile, null)
    expect(lastPrBody()).toBe("✅ kody pushed to https://github.com/x/y/pull/42")
  })
})
