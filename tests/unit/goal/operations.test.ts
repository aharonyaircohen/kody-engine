import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import {
  closeIssue,
  closePr,
  commentOnIssue,
  extractClosesIssues,
  fetchDefaultBranch,
  listGoalIssues,
  listOpenPrs,
  markPrReady,
  mergePrSquash,
  type OpenTaskPr,
  pairIssuesWithPrs,
  pickLeafPr,
  type RawGoalIssue,
} from "../../../src/goal/operations.js"
import { gh } from "../../../src/issue.js"

const ghMock = gh as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  ghMock.mockReset()
})

function fixturePr(overrides: Partial<OpenTaskPr>): OpenTaskPr {
  return {
    number: 1,
    url: "https://example/pull/1",
    isDraft: false,
    headRefName: "h",
    baseRefName: "main",
    body: "",
    ...overrides,
  }
}

describe("listGoalIssues (stacked-PR)", () => {
  it("parses each issue with the minimal RawGoalIssue shape", () => {
    ghMock.mockReturnValue(
      JSON.stringify([
        { number: 11, state: "OPEN" },
        { number: 12, state: "CLOSED" },
      ]),
    )
    const res = listGoalIssues("x", "/repo")
    expect(res.ok).toBe(true)
    expect(res.value).toEqual([
      { number: 11, state: "OPEN" },
      { number: 12, state: "CLOSED" },
    ])
  })

  it("returns ok=false on gh failure", () => {
    ghMock.mockImplementation(() => {
      throw new Error("boom")
    })
    const res = listGoalIssues("x")
    expect(res.ok).toBe(false)
    expect(res.error).toBe("boom")
  })
})

describe("listOpenPrs", () => {
  it("calls gh pr list with the stacked-PR JSON fields", () => {
    ghMock.mockReturnValue(JSON.stringify([]))
    listOpenPrs("/repo")
    expect(ghMock).toHaveBeenCalledWith(
      [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        "number,url,isDraft,headRefName,baseRefName,body",
      ],
      { cwd: "/repo" },
    )
  })
})

describe("extractClosesIssues", () => {
  it("matches Closes/Fixes/Resolves with case-insensitive variants", () => {
    expect(extractClosesIssues("Closes #42")).toEqual([42])
    expect(extractClosesIssues("fixes #7\nresolved #8")).toEqual([7, 8])
    expect(extractClosesIssues("nothing here")).toEqual([])
  })
})

describe("pairIssuesWithPrs", () => {
  const issues: RawGoalIssue[] = [
    { number: 11, state: "OPEN" },
    { number: 12, state: "OPEN" },
    { number: 13, state: "CLOSED" },
  ]

  it("draft PR via body Closes #N → prState=draft", () => {
    const prs = [fixturePr({ number: 100, isDraft: true, headRefName: "100-x", body: "Closes #11" })]
    const out = pairIssuesWithPrs(issues, prs)
    expect(out.find((i) => i.number === 11)?.prState).toBe("draft")
  })

  it("ready PR via head ref convention → prState=ready", () => {
    const prs = [fixturePr({ number: 101, isDraft: false, headRefName: "12-add-button", body: "" })]
    const out = pairIssuesWithPrs(issues, prs)
    expect(out.find((i) => i.number === 12)?.prState).toBe("ready")
  })

  it("no PR found → prState=absent", () => {
    const out = pairIssuesWithPrs(issues, [])
    expect(out.every((i) => i.prState === "absent")).toBe(true)
  })

  it("body Closes wins when both heuristics resolve to different issues", () => {
    const prs = [fixturePr({ number: 200, isDraft: true, headRefName: "13-from-branch", body: "Closes #11" })]
    const out = pairIssuesWithPrs(issues, prs)
    expect(out.find((i) => i.number === 11)?.prState).toBe("draft")
    // 13 should NOT pick up the same PR — the first heuristic already claimed it.
    expect(out.find((i) => i.number === 13)?.prState).toBe("absent")
  })
})

describe("pickLeafPr", () => {
  it("returns undefined when empty", () => {
    expect(pickLeafPr([])).toBeUndefined()
  })

  it("identifies the leaf in a true stack", () => {
    const prs = [
      fixturePr({ number: 1, headRefName: "task-1", baseRefName: "main" }),
      fixturePr({ number: 2, headRefName: "task-2", baseRefName: "task-1" }),
      fixturePr({ number: 3, headRefName: "task-3", baseRefName: "task-2" }),
    ]
    expect(pickLeafPr(prs)?.number).toBe(3)
  })

  it("picks the highest PR number when stack is malformed (parallel leaves)", () => {
    const prs = [
      fixturePr({ number: 1, headRefName: "task-1", baseRefName: "main" }),
      fixturePr({ number: 2, headRefName: "task-2", baseRefName: "main" }),
    ]
    expect(pickLeafPr(prs)?.number).toBe(2)
  })
})

describe("commentOnIssue + closeIssue + closePr + mergePrSquash + markPrReady", () => {
  it("commentOnIssue posts the body verbatim", () => {
    ghMock.mockReturnValue("")
    commentOnIssue(123, "hi")
    expect(ghMock).toHaveBeenCalledWith(["issue", "comment", "123", "--body", "hi"], expect.anything())
  })

  it("closeIssue posts comment + closes with reason", () => {
    ghMock.mockReturnValue("")
    closeIssue(7, { comment: "bye", reason: "not planned" })
    expect(ghMock).toHaveBeenCalledTimes(2)
    expect(ghMock.mock.calls[0]?.[0]).toEqual(["issue", "comment", "7", "--body", "bye"])
    expect(ghMock.mock.calls[1]?.[0]).toEqual(["issue", "close", "7", "--reason", "not planned"])
  })

  it("closeIssue skips comment when not provided", () => {
    ghMock.mockReturnValue("")
    closeIssue(7, {})
    expect(ghMock).toHaveBeenCalledTimes(1)
    expect(ghMock.mock.calls[0]?.[0]).toEqual(["issue", "close", "7"])
  })

  it("closePr forwards comment", () => {
    ghMock.mockReturnValue("")
    closePr(5, "bye")
    expect(ghMock).toHaveBeenCalledWith(["pr", "close", "5", "--comment", "bye"], expect.anything())
  })

  it("mergePrSquash forwards --squash --delete-branch", () => {
    ghMock.mockReturnValue("")
    mergePrSquash(5)
    expect(ghMock).toHaveBeenCalledWith(["pr", "merge", "5", "--squash", "--delete-branch"], expect.anything())
  })

  it("markPrReady forwards pr ready", () => {
    ghMock.mockReturnValue("")
    markPrReady(5)
    expect(ghMock).toHaveBeenCalledWith(["pr", "ready", "5"], expect.anything())
  })
})

describe("fetchDefaultBranch", () => {
  it("returns the value from gh api", () => {
    ghMock.mockReturnValue("dev\n")
    expect(fetchDefaultBranch()).toEqual({ ok: true, value: "dev" })
  })
})
