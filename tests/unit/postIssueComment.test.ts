import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  postIssueComment: vi.fn(),
  postPrReviewComment: vi.fn(),
  truncate: (s: string) => s,
}))

vi.mock("../../src/lifecycleLabels.js", () => ({
  KODY_NAMESPACE: "kody",
  setKodyLabel: vi.fn(),
}))

import type { Context, Profile } from "../../src/implementations/types.js"
import {
  postIssueComment as ghPostIssueComment,
  postPrReviewComment as ghPostPrReviewComment,
} from "../../src/issue.js"
import { setKodyLabel } from "../../src/lifecycleLabels.js"
import { postIssueComment } from "../../src/scripts/postIssueComment.js"

const profile = {} as Profile

function makeCtx(overrides: {
  commitResult?: { committed: boolean }
  hasCommitsAhead?: boolean
  prUrl?: string
  prAction?: "created" | "updated"
  agentDone?: boolean
  agentFailureReason?: string
  verifyOk?: boolean
  verifyReason?: string
  target?: "issue" | "pr"
  targetNumber?: number
  issue?: number
  exitCode?: number
  prCrashReason?: string
  commitCrash?: string
  action?: unknown
}): Context {
  const {
    commitResult = { committed: true },
    hasCommitsAhead = true,
    prUrl = "https://github.com/x/y/pull/42",
    prAction = "created",
    agentDone = true,
    agentFailureReason,
    verifyOk = true,
    verifyReason,
    target = "pr",
    targetNumber = 42,
    issue,
    exitCode = 0,
    prCrashReason,
    commitCrash,
    action,
  } = overrides

  return {
    args: issue !== undefined ? { issue } : {},
    cwd: "/tmp",
    config: {} as Context["config"],
    data: {
      commentTargetType: target,
      commentTargetNumber: targetNumber,
      commitResult,
      hasCommitsAhead,
      // Typed PrOutcome shape — see src/scripts/prOutcome.ts. Tests in this
      // suite simulate ensurePr having run successfully; for failure-path
      // tests that need the prCrashReason exit-4 branch, override prResult
      // explicitly via the `prResultOverride` field below.
      prResult: { kind: prAction, url: prUrl, number: targetNumber, draft: false },
      agentDone,
      verifyOk,
      ...(agentFailureReason ? { agentFailureReason } : {}),
      ...(verifyReason ? { verifyReason } : {}),
      ...(prCrashReason ? { prCrashReason } : {}),
      ...(commitCrash ? { commitCrash } : {}),
      ...(action ? { action } : {}),
    },
    output: { exitCode, prUrl },
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
    vi.mocked(setKodyLabel).mockClear()
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

  it("no commits + agent finished cleanly: reports no-delivery success", async () => {
    const ctx = makeCtx({
      commitResult: { committed: false },
      hasCommitsAhead: false,
      prAction: "updated",
      agentDone: true,
    })
    await postIssueComment(ctx, profile, null)
    expect(lastPrBody()).toBe("ℹ️ kody made no changes — work already satisfied; no PR needed")
    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.data.deliveryOutcome).toMatchObject({
      kind: "not_required",
      reason: "work already satisfied; no PR needed",
    })
    expect(vi.mocked(setKodyLabel)).not.toHaveBeenCalled()
  })

  it("no commits + prior delivery failure: preserves the failure", async () => {
    const ctx = makeCtx({
      commitResult: { committed: false },
      hasCommitsAhead: false,
      prAction: "updated",
      agentDone: true,
      exitCode: 4,
    })
    ctx.output.reason = "pull-request delivery produced no commit"

    await postIssueComment(ctx, profile, null)

    expect(lastPrBody()).toBe("⚠️ kody FAILED: pull-request delivery produced no commit")
    expect(ctx.output.exitCode).toBe(4)
    expect(ctx.data.deliveryOutcome).toBeUndefined()
  })

  // Regression: previously this branch always reported "no changes to commit"
  // even when the agent had failed for a more specific reason (missing DONE
  // marker, agent SDK error, etc.). That hid the real cause from operators —
  // 1436 ran 205 turns of work, all tests passed, then surfaced as "no
  // changes to commit" because the agent forgot the contract sentinel.
  it("no commits + agent failed: surfaces the specific agent failure reason", async () => {
    const ctx = makeCtx({
      commitResult: { committed: false },
      hasCommitsAhead: false,
      prAction: "updated",
      agentDone: false,
      agentFailureReason: "no DONE or FAILED marker in agent output — agent tail: …Result: 29 tests pass",
    })
    await postIssueComment(ctx, profile, null)
    const body = lastPrBody()
    expect(body).toContain("no DONE or FAILED marker")
    expect(body).toContain("29 tests pass")
    expect(body).not.toBe("⚠️ kody FAILED: no changes to commit")
    expect(ctx.output.exitCode).toBe(3)
  })

  it("no commits + agent failed: falls back to action payload reason", async () => {
    const ctx = makeCtx({
      commitResult: { committed: false },
      hasCommitsAhead: false,
      prAction: "updated",
      agentDone: false,
      action: {
        type: "REPRODUCE_FAILED",
        payload: { reason: "reproduce missing or malformed FAILURE_SIGNATURE JSON" },
        timestamp: "",
      },
    })
    await postIssueComment(ctx, profile, null)
    const body = lastPrBody()
    expect(body).toContain("malformed FAILURE_SIGNATURE")
    expect(body).not.toContain("agent did not emit DONE")
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

// Regression: terminal failure paths used to leave `kody:running` stamped on
// the issue, which the dashboard interprets as "still building". Failure
// terminus must flip the label to `kody:failed`.
describe("postIssueComment lifecycle label cleanup", () => {
  beforeEach(() => {
    vi.mocked(ghPostIssueComment).mockClear()
    vi.mocked(ghPostPrReviewComment).mockClear()
    vi.mocked(setKodyLabel).mockClear()
  })

  it("no commits + agent failure → flips kody:running to kody:failed on the issue and PR", async () => {
    const ctx = makeCtx({
      commitResult: { committed: false },
      hasCommitsAhead: false,
      prAction: "updated",
      agentDone: false,
      agentFailureReason: "agent could not validate the fix",
      issue: 1155,
      target: "pr",
      targetNumber: 1200,
    })
    await postIssueComment(ctx, profile, null)
    const calls = vi.mocked(setKodyLabel).mock.calls
    const labels = calls.map((c) => ({ n: c[0], label: (c[1] as { label: string }).label }))
    expect(labels).toEqual(
      expect.arrayContaining([
        { n: 1155, label: "kody:failed" },
        { n: 1200, label: "kody:failed" },
      ]),
    )
  })

  it("prCrash (exitCode 4) → flips kody:running to kody:failed", async () => {
    const ctx = makeCtx({
      issue: 1155,
      target: "pr",
      targetNumber: 1200,
      exitCode: 4,
      prCrashReason: "boom",
    })
    await postIssueComment(ctx, profile, null)
    const calls = vi.mocked(setKodyLabel).mock.calls
    expect(calls.some((c) => c[0] === 1155 && (c[1] as { label: string }).label === "kody:failed")).toBe(true)
  })

  it("verify failed → flips kody:running to kody:failed", async () => {
    const ctx = makeCtx({
      issue: 1155,
      target: "pr",
      targetNumber: 1200,
      verifyOk: false,
      verifyReason: "typecheck failed",
    })
    await postIssueComment(ctx, profile, null)
    const calls = vi.mocked(setKodyLabel).mock.calls
    expect(calls.some((c) => c[0] === 1155 && (c[1] as { label: string }).label === "kody:failed")).toBe(true)
  })

  // Regression: a commit that landed locally but failed to push set exit 4 +
  // `commitCrash`, but the executor blocks the mutating `ensurePr` postflight
  // on a non-zero exit, so `prCrashReason` was never set. The terminal exit
  // recompute then clobbered the 4 back to 0 — CI went green and the commit
  // was lost when the ephemeral runner was torn down.
  it("commitCrash (exit 4, no prCrashReason) → preserves exit 4 and surfaces the reason", async () => {
    const ctx = makeCtx({
      issue: 1155,
      target: "pr",
      targetNumber: 1200,
      exitCode: 4,
      commitCrash: "push rejected: remote contains work you do not have locally",
    })
    await postIssueComment(ctx, profile, null)
    expect(ctx.output.exitCode).toBe(4)
    expect(String(ctx.output.reason)).toContain("push rejected")
    const calls = vi.mocked(setKodyLabel).mock.calls
    expect(calls.some((c) => c[0] === 1155 && (c[1] as { label: string }).label === "kody:failed")).toBe(true)
  })

  it("success + created PR → stamps kody:reviewing on the issue and PR", async () => {
    const ctx = makeCtx({
      issue: 1155,
      target: "pr",
      targetNumber: 1200,
      prAction: "created",
    })
    await postIssueComment(ctx, profile, null)
    const calls = vi.mocked(setKodyLabel).mock.calls
    expect(calls).toEqual([
      [
        1155,
        {
          label: "kody:reviewing",
          color: "d93f0b",
          description: "kody: PR ready for human review",
        },
        "/tmp",
      ],
      [
        1200,
        {
          label: "kody:reviewing",
          color: "d93f0b",
          description: "kody: PR ready for human review",
        },
        "/tmp",
      ],
    ])
  })

  it("success + updated PR with no new commit → still stamps kody:reviewing", async () => {
    const ctx = makeCtx({
      issue: 1155,
      target: "pr",
      targetNumber: 1200,
      commitResult: { committed: false },
      hasCommitsAhead: true,
      prAction: "updated",
    })
    await postIssueComment(ctx, profile, null)
    expect(vi.mocked(setKodyLabel)).toHaveBeenCalledWith(
      1155,
      expect.objectContaining({ label: "kody:reviewing" }),
      "/tmp",
    )
    expect(vi.mocked(setKodyLabel)).toHaveBeenCalledWith(
      1200,
      expect.objectContaining({ label: "kody:reviewing" }),
      "/tmp",
    )
  })

  it("no-PR success path → does not stamp kody:reviewing", async () => {
    const ctx = makeCtx({
      issue: 1155,
      target: "issue",
      targetNumber: 1155,
      commitResult: { committed: false },
      hasCommitsAhead: false,
      agentDone: true,
    })
    await postIssueComment(ctx, profile, null)
    expect(vi.mocked(setKodyLabel)).not.toHaveBeenCalled()
  })
})
