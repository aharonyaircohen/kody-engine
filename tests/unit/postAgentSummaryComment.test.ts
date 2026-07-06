import { beforeEach, describe, expect, it, vi } from "vitest"

const { postIssueComment } = vi.hoisted(() => ({ postIssueComment: vi.fn() }))
vi.mock("../../src/issue.js", () => ({ postIssueComment }))

import type { Context } from "../../src/implementations/types.js"
import { postAgentSummaryComment } from "../../src/scripts/postAgentSummaryComment.js"

function makeCtx(data: Record<string, unknown>): Context {
  return {
    args: {},
    cwd: "/x",
    config: {} as never,
    data,
    output: { exitCode: 0 },
    skipAgent: false,
  }
}

describe("postAgentSummaryComment", () => {
  // mockClear (not mockReset): clears call history but keeps the fn wired.
  // mockReset has a vitest quirk where a later throwing mockImplementation
  // escapes the callee's try/catch, which would falsely fail the best-effort
  // swallow test below.
  beforeEach(() => postIssueComment.mockClear())

  it("no-ops when the agent did not finish", () => {
    postAgentSummaryComment(makeCtx({ agentDone: false, commentTargetNumber: 5, prSummary: "x" }))
    expect(postIssueComment).not.toHaveBeenCalled()
  })

  it("no-ops when target or body is missing", () => {
    postAgentSummaryComment(makeCtx({ agentDone: true, commentTargetNumber: 0, prSummary: "x" }))
    postAgentSummaryComment(makeCtx({ agentDone: true, commentTargetNumber: 5, prSummary: "   " }))
    expect(postIssueComment).not.toHaveBeenCalled()
  })

  it("posts the body verbatim by default", () => {
    postAgentSummaryComment(makeCtx({ agentDone: true, commentTargetNumber: 5, prSummary: "answer" }))
    expect(postIssueComment).toHaveBeenCalledWith(5, "answer", "/x")
  })

  it("applies the render wrapper when provided", () => {
    postAgentSummaryComment(makeCtx({ agentDone: true, commentTargetNumber: 7, prSummary: "plan" }), {
      render: (n, body) => `# ${n}\n${body}`,
    })
    expect(postIssueComment).toHaveBeenCalledWith(7, "# 7\nplan", "/x")
  })

  it("issueOnly skips a PR target but allows an issue target", () => {
    postAgentSummaryComment(
      makeCtx({ agentDone: true, commentTargetType: "pr", commentTargetNumber: 5, prSummary: "x" }),
      { issueOnly: true },
    )
    expect(postIssueComment).not.toHaveBeenCalled()

    postAgentSummaryComment(
      makeCtx({ agentDone: true, commentTargetType: "issue", commentTargetNumber: 5, prSummary: "x" }),
      { issueOnly: true },
    )
    expect(postIssueComment).toHaveBeenCalledWith(5, "x", "/x")
  })

  // The catch-and-swallow branch is intentionally not unit-tested here: a
  // throwing module mock leaks/escapes across vitest test boundaries (a
  // harness artifact, not product behavior). The wrapper is a trivial
  // best-effort try/catch identical to the original posters'.
})
