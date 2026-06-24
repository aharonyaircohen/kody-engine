import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import { commentOnIssue, mergePrSquash } from "../../../src/goal/operations.js"
import { gh } from "../../../src/issue.js"

const ghMock = gh as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  ghMock.mockReset()
})

describe("goal operations shared by merge flow", () => {
  it("commentOnIssue posts body verbatim", () => {
    ghMock.mockReturnValue("")

    expect(commentOnIssue(123, "hi", "/repo")).toEqual({ ok: true })

    expect(ghMock).toHaveBeenCalledWith(["issue", "comment", "123", "--body", "hi"], { cwd: "/repo" })
  })

  it("commentOnIssue returns ok=false on gh failure", () => {
    ghMock.mockImplementation(() => {
      throw new Error("boom\nmore")
    })

    expect(commentOnIssue(123, "hi")).toEqual({ ok: false, error: "boom" })
  })

  it("mergePrSquash forwards --squash --delete-branch", () => {
    ghMock.mockReturnValue("")

    expect(mergePrSquash(5, "/repo")).toEqual({ ok: true })

    expect(ghMock).toHaveBeenCalledWith(["pr", "merge", "5", "--squash", "--delete-branch"], { cwd: "/repo" })
  })
})
