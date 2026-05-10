import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import {
  closeIssue,
  closePr,
  commentOnIssue,
  compareBranches,
  createIssue,
  createPr,
  editPrBody,
  ensureLabel,
  fetchDefaultBranch,
  findUmbrellaByTitle,
  getIssueState,
  inferLinkedIssue,
  listGoalIssues,
  listPrsByBase,
  markPrReady,
  mergePrSquash,
} from "../../../src/goal/operations.js"
import { gh } from "../../../src/issue.js"

const ghMock = gh as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  ghMock.mockReset()
})

describe("listGoalIssues", () => {
  it("filters out the umbrella issue", () => {
    ghMock.mockReturnValue(
      JSON.stringify([
        { number: 10, state: "OPEN", labels: ["goal:x"] },
        { number: 11, state: "OPEN", labels: ["goal:x"] },
      ]),
    )
    const res = listGoalIssues("x", 10, "/repo")
    expect(res.ok).toBe(true)
    expect(res.value).toEqual([{ number: 11, state: "OPEN", labels: ["goal:x"] }])
  })

  it("returns ok=false on gh failure", () => {
    ghMock.mockImplementation(() => {
      throw new Error("boom")
    })
    const res = listGoalIssues("x", undefined)
    expect(res.ok).toBe(false)
    expect(res.error).toBe("boom")
  })

  it("returns full list when excludeIssueNumber is undefined", () => {
    ghMock.mockReturnValue(JSON.stringify([{ number: 1, state: "OPEN", labels: [] }]))
    const res = listGoalIssues("x", undefined)
    expect(res.value).toHaveLength(1)
  })
})

describe("ensureLabel/addLabel/comment", () => {
  it("ensureLabel forwards args to gh label create --force", () => {
    ghMock.mockReturnValue("")
    ensureLabel("kody:x", "ff0000", "desc")
    expect(ghMock).toHaveBeenCalledWith(
      ["label", "create", "kody:x", "--color", "ff0000", "--description", "desc", "--force"],
      expect.anything(),
    )
  })

  it("commentOnIssue posts the body verbatim", () => {
    ghMock.mockReturnValue("")
    commentOnIssue(123, "hi")
    expect(ghMock).toHaveBeenCalledWith(["issue", "comment", "123", "--body", "hi"], expect.anything())
  })
})

describe("closeIssue", () => {
  it("posts comment + closes with reason", () => {
    ghMock.mockReturnValue("")
    closeIssue(7, { comment: "bye", reason: "not planned" })
    expect(ghMock).toHaveBeenCalledTimes(2)
    expect(ghMock.mock.calls[0]?.[0]).toEqual(["issue", "comment", "7", "--body", "bye"])
    expect(ghMock.mock.calls[1]?.[0]).toEqual(["issue", "close", "7", "--reason", "not planned"])
  })

  it("skips comment when not provided", () => {
    ghMock.mockReturnValue("")
    closeIssue(7, {})
    expect(ghMock).toHaveBeenCalledTimes(1)
    expect(ghMock.mock.calls[0]?.[0]).toEqual(["issue", "close", "7"])
  })
})

describe("getIssueState", () => {
  it("normalizes to upper case", () => {
    ghMock.mockReturnValue("open")
    expect(getIssueState(1)).toEqual({ ok: true, value: "OPEN" })
  })

  it("rejects unknown states", () => {
    ghMock.mockReturnValue("weird")
    const r = getIssueState(1)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unexpected state/)
  })
})

describe("findUmbrellaByTitle", () => {
  it("returns null on empty output", () => {
    ghMock.mockReturnValue("")
    expect(findUmbrellaByTitle("g", "goal: g")).toEqual({ ok: true, value: null })
  })

  it("returns the parsed issue number", () => {
    ghMock.mockReturnValue("42\n")
    expect(findUmbrellaByTitle("g", "goal: g")).toEqual({ ok: true, value: 42 })
  })
})

describe("createIssue", () => {
  it("parses the issue number from the URL gh prints", () => {
    ghMock.mockReturnValue("https://github.com/o/r/issues/123")
    expect(createIssue({ title: "t", body: "b", labels: ["goal:g"] })).toEqual({
      ok: true,
      value: 123,
    })
  })

  it("fails when URL is malformed", () => {
    ghMock.mockReturnValue("not-a-url")
    const r = createIssue({ title: "t", body: "b", labels: [] })
    expect(r.ok).toBe(false)
  })
})

describe("PR ops", () => {
  it("listPrsByBase parses JSON output", () => {
    ghMock.mockReturnValue(
      JSON.stringify([{ number: 1, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", url: "u" }]),
    )
    const r = listPrsByBase("goal-x", "open")
    expect(r.value?.[0]?.number).toBe(1)
  })

  it("createPr requires the URL to contain /pull/", () => {
    ghMock.mockReturnValue("not-a-pr-url")
    const r = createPr({ head: "h", base: "b", title: "t", body: "b" })
    expect(r.ok).toBe(false)
  })

  it("createPr returns the URL on success", () => {
    ghMock.mockReturnValue("https://github.com/o/r/pull/9")
    expect(createPr({ head: "h", base: "b", title: "t", body: "b" }).value).toBe("https://github.com/o/r/pull/9")
  })

  it("mergePrSquash + closePr + editPrBody + markPrReady all forward args", () => {
    ghMock.mockReturnValue("")
    mergePrSquash(5)
    closePr(5, "x")
    editPrBody(5, "new body")
    markPrReady(5)
    expect(ghMock.mock.calls.map((c) => c[0]?.[0])).toEqual(["pr", "pr", "pr", "pr"])
  })
})

describe("fetchDefaultBranch + compareBranches", () => {
  it("fetchDefaultBranch returns the value from gh api", () => {
    ghMock.mockReturnValue("dev\n")
    expect(fetchDefaultBranch()).toEqual({ ok: true, value: "dev" })
  })

  it("compareBranches parses ahead+behind", () => {
    ghMock.mockReturnValue("3 1")
    expect(compareBranches("main", "feat")).toEqual({
      ok: true,
      value: { ahead: 3, behind: 1 },
    })
  })

  it("compareBranches fails on unexpected output", () => {
    ghMock.mockReturnValue("garbage")
    const r = compareBranches("main", "feat")
    expect(r.ok).toBe(false)
  })
})

describe("inferLinkedIssue", () => {
  it("matches Closes/Fixes/Resolves with case-insensitive variants", () => {
    expect(
      inferLinkedIssue({
        number: 1,
        isDraft: false,
        mergeable: "",
        mergeStateStatus: "",
        url: "",
        body: "Closes #42",
      }),
    ).toBe(42)
    expect(
      inferLinkedIssue({
        number: 1,
        isDraft: false,
        mergeable: "",
        mergeStateStatus: "",
        url: "",
        body: "fixes #7\nlater text",
      }),
    ).toBe(7)
  })

  it("falls back to leading-digits headRefName when body has no link", () => {
    expect(
      inferLinkedIssue({
        number: 1,
        isDraft: false,
        mergeable: "",
        mergeStateStatus: "",
        url: "",
        headRefName: "1453-add-button",
      }),
    ).toBe(1453)
  })

  it("returns undefined when neither path yields a number", () => {
    expect(
      inferLinkedIssue({
        number: 1,
        isDraft: false,
        mergeable: "",
        mergeStateStatus: "",
        url: "",
        body: "",
        headRefName: "no-leading-digits",
      }),
    ).toBeUndefined()
  })
})
