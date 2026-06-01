import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock the gh() shell wrapper so we exercise the pure dedup/classification
// logic of the new duty primitives without touching a real repo.
vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import { ensureComment, ensureIssue, readCheckRuns } from "../../src/dutyMcp.js"
import { gh } from "../../src/issue.js"

const REPO = "owner/repo"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ensureIssue — idempotent find-or-create by marker", () => {
  it("returns created:false and creates NOTHING when an open issue already carries the key's marker", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          { number: 7, body: "unrelated issue" },
          { number: 42, body: "dev is red\n\n<!-- kody-track:dev-ci-red -->" },
        ])
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    const result = ensureIssue(REPO, "dev-ci-red", "dev CI is red — Kody auto-fix", "body")

    expect(result).toEqual({ created: false, number: 42 })
    // No `issue create` call happened.
    const calls = vi.mocked(gh).mock.calls.map((c) => (c[0] as string[]).join(" "))
    expect(calls.some((c) => c.includes("issue create"))).toBe(false)
  })

  it("creates the issue (with the marker appended) when no open issue carries the marker", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([{ number: 7, body: "something else entirely" }])
      }
      if (args[0] === "issue" && args[1] === "create") {
        return "https://github.com/owner/repo/issues/99\n"
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    const result = ensureIssue(REPO, "dev-ci-red", "dev CI is red — Kody auto-fix", "the body")

    expect(result).toEqual({ created: true, number: 99 })
    const createCall = vi.mocked(gh).mock.calls.find((c) => (c[0] as string[])[1] === "create")
    expect(createCall).toBeDefined()
    // The marker is appended to the body passed on stdin.
    expect((createCall![1] as { input?: string })?.input).toContain("<!-- kody-track:dev-ci-red -->")
  })
})

describe("ensureComment — idempotent comment by marker", () => {
  it("does not post when a comment with the key's marker already exists", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({ comments: [{ body: "earlier\n\n<!-- kody-track-comment:dispatched -->" }] })
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    const result = ensureComment(REPO, 99, "dispatched", "hello")

    expect(result).toEqual({ posted: false })
    const calls = vi.mocked(gh).mock.calls.map((c) => (c[0] as string[]).join(" "))
    expect(calls.some((c) => c.includes("issue comment"))).toBe(false)
  })

  it("posts once (marker appended) when no marked comment exists", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ comments: [{ body: "noise" }] })
      if (args[0] === "issue" && args[1] === "comment") return ""
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    const result = ensureComment(REPO, 99, "dispatched", "the notify")

    expect(result).toEqual({ posted: true })
    const commentCall = vi.mocked(gh).mock.calls.find((c) => (c[0] as string[])[1] === "comment")
    expect((commentCall![1] as { input?: string })?.input).toContain("<!-- kody-track-comment:dispatched -->")
  })
})

describe("readCheckRuns — branch CI classification", () => {
  const sha = "abc1234def"
  function mockChecks(ndjson: string) {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "api" && /\/commits\/dev$/.test(args[1] ?? "")) return sha
      if (args[0] === "api" && /check-runs$/.test(args[1] ?? "")) return ndjson
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })
  }

  it("is RED when a non-Kody check has a terminal failure, even while others run, and excludes Kody jobs", () => {
    mockChecks(
      [
        JSON.stringify({ name: "CodeQL", status: "completed", conclusion: "failure", details_url: "u1" }),
        JSON.stringify({ name: "E2E Gate", status: "in_progress", conclusion: null, details_url: "u2" }),
        JSON.stringify({ name: "run", status: "completed", conclusion: "failure", details_url: "u3" }), // Kody job — ignored
      ].join("\n"),
    )

    const r = readCheckRuns(REPO, "dev", ["run", "kody", "job-tick"])

    expect(r.state).toBe("RED")
    expect(r.sha).toBe(sha)
    expect(r.failing.map((f) => f.name)).toEqual(["CodeQL"]) // not "run"
  })

  it("is PENDING when nothing failed but a non-Kody check is still running", () => {
    mockChecks(
      [
        JSON.stringify({ name: "CodeQL", status: "in_progress", conclusion: null, details_url: "u1" }),
        JSON.stringify({ name: "Lint", status: "completed", conclusion: "success", details_url: "u2" }),
      ].join("\n"),
    )

    expect(readCheckRuns(REPO, "dev", ["run"]).state).toBe("PENDING")
  })

  it("is GREEN when all non-Kody checks completed with no failures (cancelled/skipped ignored)", () => {
    mockChecks(
      [
        JSON.stringify({ name: "CodeQL", status: "completed", conclusion: "success", details_url: "u1" }),
        JSON.stringify({ name: "Deploy", status: "completed", conclusion: "cancelled", details_url: "u2" }),
      ].join("\n"),
    )

    expect(readCheckRuns(REPO, "dev", ["run"]).state).toBe("GREEN")
  })
})
