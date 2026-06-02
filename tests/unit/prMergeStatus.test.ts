import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
  truncate: (s: string) => s,
}))

import { gh } from "../../src/issue.js"
import { prMergeStatus } from "../../src/pr.js"

const ghMock = gh as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  ghMock.mockReset()
})

describe("prMergeStatus", () => {
  it("MERGEABLE + CLEAN → MERGEABLE", () => {
    ghMock.mockReturnValue(JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }))
    expect(prMergeStatus(1).status).toBe("MERGEABLE")
  })

  it("CONFLICTING → CONFLICTING (regardless of mergeStateStatus)", () => {
    ghMock.mockReturnValue(JSON.stringify({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }))
    expect(prMergeStatus(1).status).toBe("CONFLICTING")
  })

  it("MERGEABLE + DIRTY → CONFLICTING (covers GitHub mismatched-cache edge case)", () => {
    ghMock.mockReturnValue(JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "DIRTY" }))
    expect(prMergeStatus(1).status).toBe("CONFLICTING")
  })

  it("MERGEABLE + BLOCKED/BEHIND/UNSTABLE → BLOCKED", () => {
    for (const mss of ["BLOCKED", "BEHIND", "UNSTABLE", "UNKNOWN"]) {
      ghMock.mockReturnValue(JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: mss }))
      expect(prMergeStatus(1).status).toBe("BLOCKED")
    }
  })

  it("UNKNOWN → UNKNOWN", () => {
    ghMock.mockReturnValue(JSON.stringify({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }))
    expect(prMergeStatus(1).status).toBe("UNKNOWN")
  })

  it("gh failure → ERROR with empty raw fields", () => {
    ghMock.mockImplementation(() => {
      throw new Error("boom")
    })
    const r = prMergeStatus(1)
    expect(r.status).toBe("ERROR")
    expect(r.mergeable).toBe("")
    expect(r.mergeStateStatus).toBe("")
  })

  it("returns raw fields alongside the classification", () => {
    ghMock.mockReturnValue(JSON.stringify({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }))
    const r = prMergeStatus(1)
    expect(r.mergeable).toBe("CONFLICTING")
    expect(r.mergeStateStatus).toBe("DIRTY")
  })

  it("invokes gh with the correct args", () => {
    ghMock.mockReturnValue(JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }))
    prMergeStatus(123, "/repo")
    expect(ghMock).toHaveBeenCalledWith(["pr", "view", "123", "--json", "mergeable,mergeStateStatus"], { cwd: "/repo" })
  })
})
