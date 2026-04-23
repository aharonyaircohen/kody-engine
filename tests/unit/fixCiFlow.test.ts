import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/branch.js", () => ({
  checkoutPrBranch: vi.fn(),
  getCurrentBranch: vi.fn(() => "feature-branch"),
}))
vi.mock("../../src/issue.js", () => ({
  getPr: vi.fn(),
  getPrDiff: vi.fn(() => "diff"),
  postPrReviewComment: vi.fn(),
}))
vi.mock("../../src/workflow.js", () => ({
  getFailedRunLogTail: vi.fn(),
  pickFailedRunForFixCi: vi.fn(),
}))
vi.mock("../../src/gha.js", () => ({
  getRunUrl: vi.fn(() => ""),
}))

import type { Context, Profile } from "../../src/executables/types.js"
import { getPr, postPrReviewComment } from "../../src/issue.js"
import { fixCiFlow } from "../../src/scripts/fixCiFlow.js"
import { getFailedRunLogTail, pickFailedRunForFixCi } from "../../src/workflow.js"

const profile = {} as Profile

function makeCtx(args: Record<string, unknown>): Context {
  return {
    args,
    cwd: "/tmp",
    config: {} as Context["config"],
    data: {},
    output: { exitCode: 0 },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getPr).mockReturnValue({ state: "OPEN", number: 42 } as never)
})

describe("fixCiFlow: bail posts a PR comment", () => {
  it("posts a failure comment when no actionable run is found", async () => {
    vi.mocked(pickFailedRunForFixCi).mockReturnValue(null)
    const ctx = makeCtx({ pr: 42 })

    await fixCiFlow(ctx, profile)

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toMatch(/no actionable failed workflow run/)

    expect(postPrReviewComment).toHaveBeenCalledTimes(1)
    const body = vi.mocked(postPrReviewComment).mock.calls[0]![1]
    expect(body).toMatch(/kody fix-ci could not run/)
    expect(body).toMatch(/no actionable failed workflow run/)
  })

  it("posts a failure comment when an explicit --run-id has no fetchable logs", async () => {
    vi.mocked(getFailedRunLogTail).mockReturnValue("")
    const ctx = makeCtx({ pr: 42, runId: "99999" })

    await fixCiFlow(ctx, profile)

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toMatch(/failed to fetch log tail for run 99999/)

    expect(postPrReviewComment).toHaveBeenCalledTimes(1)
    const body = vi.mocked(postPrReviewComment).mock.calls[0]![1]
    expect(body).toMatch(/kody fix-ci could not run/)
  })

  it("posts a failure comment when the PR is not OPEN", async () => {
    vi.mocked(getPr).mockReturnValue({ state: "CLOSED", number: 42 } as never)
    const ctx = makeCtx({ pr: 42 })

    await fixCiFlow(ctx, profile)

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(1)
    expect(postPrReviewComment).toHaveBeenCalledTimes(1)
    const body = vi.mocked(postPrReviewComment).mock.calls[0]![1]
    expect(body).toMatch(/is not OPEN/)
  })
})

describe("fixCiFlow: happy path", () => {
  it("populates ctx.data from the picked run and posts the started comment", async () => {
    vi.mocked(pickFailedRunForFixCi).mockReturnValue({
      run: {
        id: "12345",
        workflowName: "CI",
        headBranch: "feature-branch",
        conclusion: "failure",
        url: "https://example.com/runs/12345",
        createdAt: "t",
      },
      logTail: "failing test output",
    })
    const ctx = makeCtx({ pr: 42 })

    await fixCiFlow(ctx, profile)

    expect(ctx.skipAgent).toBeFalsy()
    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.data.failedRunId).toBe("12345")
    expect(ctx.data.failedWorkflowName).toBe("CI")
    expect(ctx.data.failedLogTail).toBe("failing test output")
    expect(postPrReviewComment).toHaveBeenCalledTimes(1)
    const body = vi.mocked(postPrReviewComment).mock.calls[0]![1]
    expect(body).toMatch(/kody fix-ci started/)
    expect(body).toMatch(/analyzing workflow run 12345/)
  })
})
