/**
 * Unit coverage for the `qa-engineer` postflight `openQaIssue`.
 *
 * The script takes the agent's final report and either comments on an existing
 * issue (--issue N) or opens a fresh labeled issue. The only path that writes
 * to GitHub is `src/issue.js` (gh / postIssueComment), so we mock that module
 * and assert on ctx.data.action, ctx.output, and the gh calls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  gh: vi.fn(),
  postIssueComment: vi.fn(),
}))

vi.mock("../../src/issue.js", async (orig) => {
  const actual = (await orig()) as typeof import("../../src/issue.js")
  return { ...actual, gh: mocks.gh, postIssueComment: mocks.postIssueComment }
})

import type { AgentResult } from "../../src/agent.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { openQaIssue } from "../../src/scripts/openQaIssue.js"

const profile = {} as Profile

function makeCtx(args: Record<string, unknown>): Context {
  return {
    args,
    cwd: "/repo",
    config: { github: { owner: "acme", repo: "widget" } } as never,
    data: {},
    output: { exitCode: 0 },
  } as Context
}

function makeAgent(finalText: string, outcome: "completed" | "failed" = "completed", error?: string): AgentResult {
  return { outcome, finalText, error, ndjsonPath: "/tmp/x.jsonl" } as AgentResult
}

const PASS = "## Verdict: PASS\nAll smoke checks green."
const CONCERNS = "## Verdict: CONCERNS\nSlow login but works."
const FAIL = "## Verdict: FAIL\nLogin 500s."
const NO_VERDICT = "Ran the smoke suite, looks fine."

beforeEach(() => {
  mocks.gh.mockReset()
  mocks.postIssueComment.mockReset()
})

describe("openQaIssue: failure / guard paths", () => {
  it("agent did not complete → exit 1 + QA_FAILED action", async () => {
    const ctx = makeCtx({})

    await openQaIssue(ctx, profile, makeAgent("anything", "failed", "model_error: boom"))

    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toBe("model_error: boom")
    expect((ctx.data.action as { type: string }).type).toBe("QA_FAILED")
    expect(mocks.gh).not.toHaveBeenCalled()
  })

  it("null agent result → exit 1 with default reason", async () => {
    const ctx = makeCtx({})

    await openQaIssue(ctx, profile, null)

    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toBe("agent did not complete")
    expect((ctx.data.action as { type: string }).type).toBe("QA_FAILED")
  })

  it("empty report body → exit 1 + QA_FAILED", async () => {
    const ctx = makeCtx({})

    await openQaIssue(ctx, profile, makeAgent("   \n  "))

    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toBe("empty report body")
    expect((ctx.data.action as { type: string }).type).toBe("QA_FAILED")
    expect(mocks.gh).not.toHaveBeenCalled()
  })
})

describe("openQaIssue: comment on an existing issue", () => {
  it("posts the report as a comment and exits 0 on PASS", async () => {
    const ctx = makeCtx({ issue: 7 })

    await openQaIssue(ctx, profile, makeAgent(PASS))

    expect(mocks.postIssueComment).toHaveBeenCalledWith(7, PASS, "/repo")
    expect(mocks.gh).not.toHaveBeenCalled()
    expect(ctx.data.qaVerdict).toBe("PASS")
    expect(ctx.data.qaReport).toBe(PASS)
    expect(ctx.output.exitCode).toBe(0)
    const action = ctx.data.action as { type: string; payload: Record<string, unknown> }
    expect(action.type).toBe("QA_PASS")
    expect(action.payload).toMatchObject({ verdict: "PASS", issueNumber: 7, mode: "comment" })
  })

  it("exits 1 on a FAIL verdict comment", async () => {
    const ctx = makeCtx({ issue: 9 })

    await openQaIssue(ctx, profile, makeAgent(FAIL))

    expect(ctx.output.exitCode).toBe(1)
    expect((ctx.data.action as { type: string }).type).toBe("QA_FAIL")
  })

  it("CONCERNS comment exits 0 with a QA_CONCERNS action", async () => {
    const ctx = makeCtx({ issue: 3 })

    await openQaIssue(ctx, profile, makeAgent(CONCERNS))

    expect(ctx.output.exitCode).toBe(0)
    expect((ctx.data.action as { type: string }).type).toBe("QA_CONCERNS")
  })

  it("a non-positive issue number is ignored → opens a new issue instead", async () => {
    mocks.gh.mockImplementation((args: string[]) => {
      if (args[0] === "label") return ""
      return "https://github.com/acme/widget/issues/100"
    })
    const ctx = makeCtx({ issue: 0 })

    await openQaIssue(ctx, profile, makeAgent(PASS))

    expect(mocks.postIssueComment).not.toHaveBeenCalled()
    expect((ctx.data.action as { payload: Record<string, unknown> }).payload.mode).toBe("create")
  })

  it("comment failure → exit 4 + QA_FAILED action", async () => {
    mocks.postIssueComment.mockImplementation(() => {
      throw new Error("network down")
    })
    const ctx = makeCtx({ issue: 5 })

    await openQaIssue(ctx, profile, makeAgent(PASS))

    expect(ctx.output.exitCode).toBe(4)
    expect(ctx.output.reason).toContain("failed to comment on issue #5")
    expect(ctx.output.reason).toContain("network down")
    expect((ctx.data.action as { type: string }).type).toBe("QA_FAILED")
  })
})

describe("openQaIssue: open a new issue", () => {
  it("ensures the label, creates a labeled issue, and exits 0 on PASS", async () => {
    mocks.gh.mockImplementation((args: string[]) => {
      if (args[0] === "label") return ""
      return "Creating issue\nhttps://github.com/acme/widget/issues/123"
    })
    const ctx = makeCtx({ scope: "Checkout Flow" })

    await openQaIssue(ctx, profile, makeAgent(PASS))

    // First call ensures the label exists.
    expect(mocks.gh.mock.calls[0]?.[0]).toEqual([
      "label",
      "create",
      "kody:qa-report",
      "--color",
      "8b5cf6",
      "--description",
      "kody: QA report",
      "--force",
    ])
    // Second call creates the issue, labeled because ensureLabel succeeded.
    const createArgs = mocks.gh.mock.calls[1]?.[0] as string[]
    expect(createArgs).toContain("create")
    expect(createArgs).toContain("--label")
    expect(createArgs).toContain("kody:qa-report")
    const title = createArgs[createArgs.indexOf("--title") + 1]
    expect(title).toContain("QA [PASS]: Checkout Flow")

    expect(ctx.output.exitCode).toBe(0)
    const action = ctx.data.action as { type: string; payload: Record<string, unknown> }
    expect(action.type).toBe("QA_PASS")
    expect(action.payload).toMatchObject({
      issueNumber: 123,
      issueUrl: "https://github.com/acme/widget/issues/123",
      titleSlug: "checkout-flow",
      mode: "create",
    })
  })

  it("defaults the title focus to 'smoke' and slug to 'smoke' when no scope", async () => {
    mocks.gh.mockImplementation((args: string[]) => {
      if (args[0] === "label") return ""
      return "https://github.com/acme/widget/issues/55"
    })
    const ctx = makeCtx({})

    await openQaIssue(ctx, profile, makeAgent(NO_VERDICT))

    const createArgs = mocks.gh.mock.calls[1]?.[0] as string[]
    const title = createArgs[createArgs.indexOf("--title") + 1]
    // UNKNOWN verdict renders the REPORT tag and the default smoke focus.
    expect(title).toContain("QA [REPORT]: smoke")
    expect(ctx.data.qaVerdict).toBe("UNKNOWN")
    expect((ctx.data.action as { type: string }).type).toBe("QA_COMPLETED")
    expect((ctx.data.action as { payload: Record<string, unknown> }).payload.titleSlug).toBe("smoke")
  })

  it("omits --label when ensureLabel fails (no repo-admin scope)", async () => {
    mocks.gh.mockImplementation((args: string[]) => {
      if (args[0] === "label") throw new Error("HTTP 403")
      return "https://github.com/acme/widget/issues/77"
    })
    const ctx = makeCtx({})

    await openQaIssue(ctx, profile, makeAgent(PASS))

    const createArgs = mocks.gh.mock.calls[1]?.[0] as string[]
    expect(createArgs).not.toContain("--label")
    expect(ctx.output.exitCode).toBe(0)
  })

  it("FAIL verdict on a new issue exits 1", async () => {
    mocks.gh.mockImplementation((args: string[]) => {
      if (args[0] === "label") return ""
      return "https://github.com/acme/widget/issues/88"
    })
    const ctx = makeCtx({})

    await openQaIssue(ctx, profile, makeAgent(FAIL))

    expect(ctx.output.exitCode).toBe(1)
    expect((ctx.data.action as { type: string }).type).toBe("QA_FAIL")
  })

  it("unparseable gh issue-create output → exit 4 + QA_FAILED", async () => {
    mocks.gh.mockImplementation((args: string[]) => {
      if (args[0] === "label") return ""
      return "Something went wrong, no URL here"
    })
    const ctx = makeCtx({})

    await openQaIssue(ctx, profile, makeAgent(PASS))

    expect(ctx.output.exitCode).toBe(4)
    expect(ctx.output.reason).toContain("failed to open QA issue")
    expect((ctx.data.action as { type: string }).type).toBe("QA_FAILED")
  })
})
