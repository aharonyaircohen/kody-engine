import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
  truncate: (s: string) => s,
}))
vi.mock("../../src/pushWithRetry.js", () => ({
  pushWithRetry: vi.fn(() => ({ ok: true })),
}))
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}))

import { execFileSync } from "node:child_process"
import { gh } from "../../src/issue.js"
import { ensurePr } from "../../src/pr.js"

const ghMock = gh as unknown as ReturnType<typeof vi.fn>
const execMock = execFileSync as unknown as ReturnType<typeof vi.fn>

const base = {
  branch: "42-feature",
  defaultBranch: "main",
  issueNumber: 42,
  issueTitle: "Add feature",
  draft: false,
  changedFiles: ["src/x.ts"],
  cwd: "/repo",
}

beforeEach(() => {
  ghMock.mockReset()
  execMock.mockReset()
})

describe("pr: phantom-recovery refuses to delete on lookup failure", () => {
  it("throws instead of deleting the branch when the PR lookup errors", () => {
    // 1. initial findExistingPr → lookup fails (network)
    // 2. gh pr create → "already exists" (GitHub says a live PR owns the branch)
    // 3. recovery re-lookup → fails again
    // Old behavior: treated the failed lookup as "no PR" and deleted the
    // live PR's head branch (auto-closing it). Now: refuse loudly.
    ghMock
      .mockImplementationOnce(() => {
        throw new Error("HTTP 502 from api.github.com")
      })
      .mockImplementationOnce(() => {
        throw new Error("a pull request for branch '42-feature' already exists")
      })
      .mockImplementationOnce(() => {
        throw new Error("HTTP 502 from api.github.com")
      })

    expect(() => ensurePr(base)).toThrow(/refusing phantom-PR recovery/)
    // The destructive `git push origin --delete` must never have run.
    const gitCalls = execMock.mock.calls.filter((c) => c[0] === "git")
    expect(gitCalls.some((c) => (c[1] as string[]).includes("--delete"))).toBe(false)
  })
})

describe("pr: draft promotion and body preservation on update", () => {
  const existingDraft = [
    {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      body: "Closes #42",
      title: "[WIP] #42: Add feature",
      isDraft: true,
    },
  ]

  it("promotes a draft PR to ready (and strips [WIP]) when the run succeeded", () => {
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") return JSON.stringify(existingDraft)
      return ""
    })

    const result = ensurePr(base) // draft: false → green run
    expect(result.action).toBe("updated")

    const calls = ghMock.mock.calls.map((c) => c[0] as string[])
    expect(calls.some((a) => a[0] === "pr" && a[1] === "ready" && a[2] === "7")).toBe(true)
    const titlePatch = calls.find((a) => a[0] === "api" && a.some((x) => String(x).startsWith("title=")))
    expect(titlePatch?.some((x) => String(x) === "title=#42: Add feature")).toBe(true)
  })

  it("does not touch draft state when the update itself is a failure (draft=true)", () => {
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") return JSON.stringify(existingDraft)
      return ""
    })

    ensurePr({ ...base, draft: true, failureReason: "verify failed" })
    const calls = ghMock.mock.calls.map((c) => c[0] as string[])
    expect(calls.some((a) => a[0] === "pr" && a[1] === "ready")).toBe(false)
  })

  it("skips the body PATCH when preserveBodyOnUpdate is set (no-commit rerun)", () => {
    ghMock.mockImplementation((args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") return JSON.stringify(existingDraft)
      return ""
    })

    ensurePr({ ...base, preserveBodyOnUpdate: true })
    const calls = ghMock.mock.calls.map((c) => c[0] as string[])
    expect(calls.some((a) => a[0] === "api" && a.some((x) => String(x).startsWith("body=")))).toBe(false)
    // Promotion still happens — the rerun was green even without new commits.
    expect(calls.some((a) => a[0] === "pr" && a[1] === "ready")).toBe(true)
  })
})
