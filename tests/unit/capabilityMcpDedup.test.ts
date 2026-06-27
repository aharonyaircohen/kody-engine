import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Mock the gh() shell wrapper so we exercise the pure dedup/classification
// logic of the new capability primitives without touching a real repo.
vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import { dispatchWorkflow, ensureComment, ensureIssue, readCheckRuns } from "../../src/capabilityMcp.js"
import { gh } from "../../src/issue.js"

const REPO = "owner/repo"

// `sync` ships in kody-store, not the engine root. CI clones the store
// alongside the repo; locally that clone may be missing, so set up a stub
// `sync` capability folder in a temp cwd so the registry resolves it
// regardless of whether the store is present. The stub declares `pr` as a
// required int input so `expectedDispatchTarget` recognises it as
// PR-targeted.
let fixtureRoot: string
let prevCwd: string

beforeAll(() => {
  prevCwd = process.cwd()
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kody-capability-mcp-dedup-"))
  const dir = path.join(fixtureRoot, ".kody", "capabilities", "sync")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "profile.json"),
    JSON.stringify({
      name: "sync",
      action: "sync",
      agentAction: "sync",
      capabilityKind: "act",
      role: "primitive",
      describe: "Stub sync capability for capabilityMcpDedup tests.",
      inputs: [{ name: "pr", flag: "--pr", type: "int", required: true }],
    }),
  )
  fs.writeFileSync(path.join(dir, "capability.md"), "# Sync\n")
  process.chdir(fixtureRoot)
})

afterAll(() => {
  if (prevCwd) {
    try {
      process.chdir(prevCwd)
    } catch {
      /* cwd already gone — fine */
    }
  }
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

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

describe("dispatchWorkflow — target kind guard", () => {
  it("refuses to dispatch issue-targeted run on a pull request number", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "api" && args[1] === `repos/${REPO}/issues/413`) {
        return JSON.stringify({ number: 413, pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/413` } })
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    const result = dispatchWorkflow("kody.yml", "run", 413, REPO)

    expect(result).toEqual({
      ok: false,
      error: "refusing to dispatch run on PR #413; dispatch the source issue or use a PR action",
    })
    expect(vi.mocked(gh).mock.calls.some((c) => (c[0] as string[]).includes("workflow"))).toBe(false)
  })

  it("allows PR-targeted actions on pull request numbers", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "api" && args[1] === `repos/${REPO}/issues/413`) {
        return JSON.stringify({ number: 413, pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/413` } })
      }
      if (args[0] === "workflow" && args[1] === "run") return ""
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    expect(dispatchWorkflow("kody.yml", "sync", 413, REPO)).toEqual({ ok: true })
    expect(vi.mocked(gh).mock.calls.map((c) => c[0] as string[])).toContainEqual([
      "workflow",
      "run",
      "kody.yml",
      "-f",
      "capability=sync",
      "-f",
      "issue_number=413",
    ])
  })

  it("refuses PR-targeted actions on issue numbers", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "api" && args[1] === `repos/${REPO}/issues/373`) {
        return JSON.stringify({ number: 373 })
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    const result = dispatchWorkflow("kody.yml", "sync", 373, REPO)

    expect(result).toEqual({
      ok: false,
      error: "refusing to dispatch sync on issue #373; expected a PR target",
    })
    expect(vi.mocked(gh).mock.calls.some((c) => (c[0] as string[]).includes("workflow"))).toBe(false)
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

  it("uses repo token for check-run reads", () => {
    mockChecks(JSON.stringify({ name: "health", status: "completed", conclusion: "success", details_url: "u1" }))

    readCheckRuns(REPO, "dev", [])

    expect(vi.mocked(gh).mock.calls).toEqual([
      [["api", `repos/${REPO}/commits/dev`, "--jq", ".sha"], { preferRepoToken: true }],
      [
        [
          "api",
          `repos/${REPO}/commits/${sha}/check-runs`,
          "--paginate",
          "--jq",
          ".check_runs[] | {name, status, conclusion, details_url}",
        ],
        { preferRepoToken: true },
      ],
    ])
  })

  it("is RED when a non-Kody check has a terminal failure, even while others run, and excludes Kody jobs", () => {
    mockChecks(
      [
        JSON.stringify({ name: "CodeQL", status: "completed", conclusion: "failure", details_url: "u1" }),
        JSON.stringify({ name: "E2E Gate", status: "in_progress", conclusion: null, details_url: "u2" }),
        JSON.stringify({ name: "run", status: "completed", conclusion: "failure", details_url: "u3" }), // Kody job — ignored
      ].join("\n"),
    )

    const r = readCheckRuns(REPO, "dev", ["run", "kody", "capability-tick"])

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
