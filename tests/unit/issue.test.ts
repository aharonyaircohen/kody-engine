import * as childProcess from "node:child_process"
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest"

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, execFileSync: vi.fn() }
})

import { formatIssueComments, getIssue, isReviewShaped, truncate } from "../../src/issue.js"

const execFileSync = childProcess.execFileSync as unknown as Mock

beforeEach(() => {
  execFileSync.mockReset()
})

describe("issue: formatIssueComments", () => {
  const c = (body: string, author: string, createdAt: string) => ({ body, author, createdAt })

  it("returns placeholder when there are no comments", () => {
    expect(formatIssueComments([], 12, 16_000)).toBe("(no comments yet)")
  })

  it("orders most-recent first and includes author + timestamp", () => {
    const out = formatIssueComments(
      [c("first", "alice", "2026-01-01T00:00:00Z"), c("second", "bob", "2026-01-02T00:00:00Z")],
      12,
      16_000,
    )
    expect(out.indexOf("second")).toBeLessThan(out.indexOf("first"))
    expect(out).toContain("**bob** (2026-01-02T00:00:00Z)")
  })

  it("caps the number of comments at the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => c(`body${i}`, "u", `2026-01-${i + 1}T00:00:00Z`))
    const out = formatIssueComments(many, 3, 16_000)
    expect(out.split("\n\n")).toHaveLength(3)
  })

  it("truncates an over-long comment body", () => {
    const out = formatIssueComments([c("x".repeat(100), "u", "2026-01-01T00:00:00Z")], 12, 10)
    expect(out).toContain("… (+90 chars)")
  })
})

describe("issue: truncate", () => {
  it("returns string unchanged when within limit", () => {
    expect(truncate("hello", 100)).toBe("hello")
  })

  it("truncates long strings with ellipsis suffix", () => {
    const result = truncate("x".repeat(100), 50)
    expect(result.startsWith("x".repeat(50))).toBe(true)
    expect(result).toMatch(/\+50 chars/)
  })

  it("does not error on empty string", () => {
    expect(truncate("", 100)).toBe("")
  })

  it("handles exact-length input", () => {
    expect(truncate("12345", 5)).toBe("12345")
  })
})

describe("issue: isReviewShaped", () => {
  it("accepts a body with a `## Verdict:` heading", () => {
    expect(isReviewShaped("## Verdict: PASS\n\nBody")).toBe(true)
  })

  it("accepts a body with `### Verdict:` (any heading depth)", () => {
    expect(isReviewShaped("### Verdict: CONCERNS")).toBe(true)
  })

  it("accepts a verdict heading that appears after leading content", () => {
    expect(isReviewShaped("Now I have everything needed.\n\n## Verdict: FAIL")).toBe(true)
  })

  it("is case-insensitive on the `Verdict` keyword", () => {
    expect(isReviewShaped("## verdict: pass")).toBe(true)
  })

  it("rejects a plain `@kody fix` trigger", () => {
    expect(isReviewShaped("@kody fix")).toBe(false)
  })

  it("rejects a task-state block", () => {
    expect(isReviewShaped("<!-- kody:state:v1:begin -->\n```json\n{}\n```")).toBe(false)
  })

  it("rejects a progress ping", () => {
    expect(isReviewShaped("👀 kody review started on PR #1, run …")).toBe(false)
  })

  it("rejects a status message", () => {
    expect(isReviewShaped("✅ kody pushed to https://github.com/x/y/pull/1")).toBe(false)
  })

  it("rejects a body that only mentions the word verdict in prose", () => {
    expect(isReviewShaped("Rendering the verdict in the UI")).toBe(false)
  })

  it("rejects an empty body", () => {
    expect(isReviewShaped("")).toBe(false)
  })
})

describe("issue: getIssue", () => {
  it("marks GitHub issue-view responses whose URL is a pull request", () => {
    execFileSync.mockReturnValue(
      JSON.stringify({
        number: 413,
        title: "#373: Button fix",
        body: "",
        comments: [],
        labels: [],
        url: "https://github.com/owner/repo/pull/413",
      }),
    )

    expect(getIssue(413).isPullRequest).toBe(true)
  })

  it("does not mark normal issue URLs as pull requests", () => {
    execFileSync.mockReturnValue(
      JSON.stringify({
        number: 373,
        title: "Button fix",
        body: "",
        comments: [],
        labels: [],
        url: "https://github.com/owner/repo/issues/373",
      }),
    )

    expect(getIssue(373).isPullRequest).toBe(false)
  })
})
