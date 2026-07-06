import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/branch.js", () => ({
  ensureFeatureBranch: vi.fn(),
}))

vi.mock("../../src/gha.js", () => ({
  getRunUrl: vi.fn(() => ""),
}))

vi.mock("../../src/issue.js", () => ({
  DEFAULT_COMMENT_LIMIT: 100,
  DEFAULT_COMMENT_MAX_BYTES: 6000,
  formatIssueComments: vi.fn(() => "(comments)"),
  getIssue: vi.fn(),
  postIssueComment: vi.fn(),
}))

import { ensureFeatureBranch } from "../../src/branch.js"
import type { Context } from "../../src/implementations/types.js"
import { getIssue, postIssueComment } from "../../src/issue.js"
import { runFlow } from "../../src/scripts/runFlow.js"

const profile = {} as never

function makeCtx(issue = 413): Context {
  return {
    args: { issue },
    cwd: "/repo",
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "dev" },
      github: { owner: "owner", repo: "repo" },
      state: { repo: "owner/kody-state", path: "repo" },
      agent: { model: "m/x" },
    },
    data: {},
    output: { exitCode: 0 },
  }
}

describe("runFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("refuses to run issue work against a pull request target", async () => {
    vi.mocked(getIssue).mockReturnValue({
      number: 413,
      title: "#373: Button fix",
      body: "",
      comments: [],
      isPullRequest: true,
    })

    const ctx = makeCtx(413)
    await runFlow(ctx, profile)

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toMatch(/pull request/)
    expect(ctx.data.commentTargetType).toBe("pr")
    expect(ctx.data.commentTargetNumber).toBe(413)
    expect(ensureFeatureBranch).not.toHaveBeenCalled()
    expect(postIssueComment).not.toHaveBeenCalled()
  })

  it("continues normal issue work for real issue targets", async () => {
    vi.mocked(getIssue).mockReturnValue({
      number: 373,
      title: "Button fix",
      body: "",
      comments: [],
      isPullRequest: false,
    })
    vi.mocked(ensureFeatureBranch).mockReturnValue({ branch: "373-button-fix", created: false })

    const ctx = makeCtx(373)
    await runFlow(ctx, profile)

    expect(ctx.skipAgent).toBeUndefined()
    expect(ctx.data.commentTargetType).toBe("issue")
    expect(ctx.data.commentTargetNumber).toBe(373)
    expect(ctx.data.branch).toBe("373-button-fix")
    expect(ensureFeatureBranch).toHaveBeenCalledWith(373, "Button fix", "dev", "/repo", undefined)
    expect(postIssueComment).toHaveBeenCalled()
  })
})
