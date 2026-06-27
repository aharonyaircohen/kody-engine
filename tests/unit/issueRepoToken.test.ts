import * as childProcess from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest"

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, execFileSync: vi.fn() }
})

import {
  getIssue,
  getPr,
  getPrComments,
  getPrDiff,
  getPrReviews,
  postIssueComment,
  postPrReviewComment,
} from "../../src/issue.js"

const execFileSync = childProcess.execFileSync as unknown as Mock
const TOKEN_ENV_KEYS = ["GITHUB_TOKEN", "KODY_TOKEN", "GH_TOKEN", "GH_PAT"] as const

type ExecCall = [string, string[], { env?: NodeJS.ProcessEnv }]

function expectAllCallsUseRepoToken(): void {
  for (const call of execFileSync.mock.calls as unknown as ExecCall[]) {
    expect(call[2]?.env?.GH_TOKEN).toBe("repo-token")
  }
}

beforeEach(() => {
  execFileSync.mockReset()
  process.env.GITHUB_TOKEN = "repo-token"
  process.env.GH_PAT = "state-token"
})

afterEach(() => {
  for (const key of TOKEN_ENV_KEYS) delete process.env[key]
})

describe("current repo GitHub helpers", () => {
  it("use the repo token for issue reads and comments", () => {
    execFileSync
      .mockReturnValueOnce(JSON.stringify({ number: 1, title: "Issue", body: "", comments: [], labels: [] }))
      .mockReturnValueOnce("")

    getIssue(1, "/repo")
    postIssueComment(1, "done", "/repo")

    expectAllCallsUseRepoToken()
  })

  it("use the repo token for PR reads and comments", () => {
    execFileSync
      .mockReturnValueOnce(
        JSON.stringify({
          number: 2,
          title: "PR",
          body: "",
          headRefName: "feature",
          baseRefName: "main",
          state: "OPEN",
        }),
      )
      .mockReturnValueOnce("diff")
      .mockReturnValueOnce(JSON.stringify({ reviews: [] }))
      .mockReturnValueOnce(JSON.stringify({ comments: [] }))
      .mockReturnValueOnce("")

    getPr(2, "/repo")
    getPrDiff(2, "/repo")
    getPrReviews(2, "/repo")
    getPrComments(2, "/repo")
    postPrReviewComment(2, "review", "/repo")

    expectAllCallsUseRepoToken()
  })
})
