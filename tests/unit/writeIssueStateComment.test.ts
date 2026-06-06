/**
 * Unit tests for `writeIssueStateComment` — the postflight that persists
 * the next issue-state envelope to the marker-keyed state comment.
 *
 * Covers the validation gates and the loaded-vs-fresh comment branch
 * (the create-vs-update decision is the most error-prone bit — a regression
 * would either duplicate the state comment or fail to update it).
 *
 * Mocks `issueStateComment.ts` since it shells out to `gh`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/scripts/issueStateComment.js", () => ({
  createStateComment: vi.fn(),
  updateStateComment: vi.fn(),
}))

import { createStateComment, updateStateComment } from "../../src/scripts/issueStateComment.js"
import { writeIssueStateComment } from "../../src/scripts/writeIssueStateComment.js"
import type { Context, Profile } from "../../src/executables/types.js"
import type { StateEnvelope } from "../../src/scripts/issueStateComment.js"

const profile = {} as unknown as Profile

function makeCtx(args: Record<string, unknown>, data: Record<string, unknown> = {}): Context {
  return {
    args,
    cwd: "/x",
    config: { github: { owner: "o", repo: "r" } } as never,
    data,
    output: { exitCode: 0 } as { exitCode: number; reason?: string },
  } as unknown as Context
}

const NEXT: StateEnvelope = {
  version: 1,
  rev: 1,
  cursor: "step-1",
  data: { count: 1 },
  done: false,
}

describe("writeIssueStateComment: validation gates", () => {
  beforeEach(() => {
    vi.mocked(createStateComment).mockClear()
    vi.mocked(updateStateComment).mockClear()
  })

  it("throws when `with.marker` is missing", async () => {
    const ctx = makeCtx({ issue: 1 }, { nextIssueState: NEXT })
    await expect(writeIssueStateComment(ctx, profile, null, {})).rejects.toThrow(
      /`with\.marker` is required/,
    )
  })

  it("throws when the issue arg is not a positive integer", async () => {
    const ctx = makeCtx({ issue: 0 }, { nextIssueState: NEXT })
    await expect(
      writeIssueStateComment(ctx, profile, null, { marker: "kody-issue-state" }),
    ).rejects.toThrow(/must be a positive integer/)
  })

  it("throws when the named issue arg is absent", async () => {
    const ctx = makeCtx({}, { nextIssueState: NEXT })
    await expect(
      writeIssueStateComment(ctx, profile, null, { marker: "kody-issue-state" }),
    ).rejects.toThrow(/must be a positive integer/)
  })

  it("honors a custom `issueArg` (e.g. for `pr` flows)", async () => {
    // Some primitives name the input `pr` instead of `issue`. The script must
    // resolve the issue number through the configured key, not hardcode `issue`.
    const ctx = makeCtx({ pr: 42 }, { nextIssueState: NEXT })
    await writeIssueStateComment(ctx, profile, null, {
      marker: "kody-issue-state",
      issueArg: "pr",
    })
    expect(createStateComment).toHaveBeenCalledWith("o", "r", 42, "kody-issue-state", NEXT, "/x")
  })
})

describe("writeIssueStateComment: parse-error early-exit", () => {
  beforeEach(() => {
    vi.mocked(createStateComment).mockClear()
    vi.mocked(updateStateComment).mockClear()
  })

  it("sets exit 1 + reason and does not touch the state comment", async () => {
    const ctx = makeCtx(
      { issue: 1 },
      { nextStateParseError: "missing `kody-issue-state` block in agent output" },
    )
    await writeIssueStateComment(ctx, profile, null, { marker: "kody-issue-state" })
    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toMatch(/next-state parse failed/)
    expect(createStateComment).not.toHaveBeenCalled()
    expect(updateStateComment).not.toHaveBeenCalled()
  })

  it("never lowers a pre-existing non-zero exit code", async () => {
    // If a prior postflight (e.g. verify) already set exit=2, the parse-error
    // path must not silently downgrade it back to 1.
    const ctx = makeCtx(
      { issue: 1 },
      { nextStateParseError: "missing `kody-issue-state` block in agent output" },
    )
    ctx.output.exitCode = 2
    await writeIssueStateComment(ctx, profile, null, { marker: "kody-issue-state" })
    expect(ctx.output.exitCode).toBe(2)
  })
})

describe("writeIssueStateComment: write paths", () => {
  beforeEach(() => {
    vi.mocked(createStateComment).mockClear()
    vi.mocked(updateStateComment).mockClear()
  })

  it("is a no-op when the agent emitted no next state", async () => {
    const ctx = makeCtx({ issue: 1 }, {})
    await writeIssueStateComment(ctx, profile, null, { marker: "kody-issue-state" })
    expect(createStateComment).not.toHaveBeenCalled()
    expect(updateStateComment).not.toHaveBeenCalled()
  })

  it("throws when github.owner/repo is missing", async () => {
    const ctx = makeCtx({ issue: 1 }, { nextIssueState: NEXT })
    ctx.config = { github: { owner: "", repo: "" } } as never
    await expect(
      writeIssueStateComment(ctx, profile, null, { marker: "kody-issue-state" }),
    ).rejects.toThrow(/github\.owner\/repo must be set/)
  })

  it("creates a new state comment when none is loaded", async () => {
    // First-ever run: no prior state comment, so the script must create one
    // (and not call updateStateComment with a stale id).
    const ctx = makeCtx({ issue: 7 }, { nextIssueState: NEXT, issueStateComment: null })
    await writeIssueStateComment(ctx, profile, null, { marker: "kody-issue-state" })
    expect(createStateComment).toHaveBeenCalledWith("o", "r", 7, "kody-issue-state", NEXT, "/x")
    expect(updateStateComment).not.toHaveBeenCalled()
  })

  it("updates the existing state comment when a loaded comment is in ctx.data", async () => {
    // Subsequent run: the preflight already located the prior state comment.
    // The script must update it (preserves the comment's minimized/collapsed
    // state + history) instead of creating a duplicate.
    const ctx = makeCtx(
      { issue: 7 },
      {
        nextIssueState: NEXT,
        issueStateComment: {
          commentId: 123,
          commentNodeId: "C_abc",
          state: NEXT,
        },
      },
    )
    await writeIssueStateComment(ctx, profile, null, { marker: "kody-issue-state" })
    expect(updateStateComment).toHaveBeenCalledWith("o", "r", 123, "C_abc", "kody-issue-state", NEXT, "/x")
    expect(createStateComment).not.toHaveBeenCalled()
  })
})

afterEach(() => {
  vi.mocked(createStateComment).mockReset()
  vi.mocked(updateStateComment).mockReset()
})
