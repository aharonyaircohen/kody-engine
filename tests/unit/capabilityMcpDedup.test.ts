import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock the gh() shell wrapper so we exercise the pure dedup/classification
// logic of the new capability primitives without touching a real repo.
vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import {
  capabilityToolDefinitions,
  dispatchWorkflow,
  ensureComment,
  ensureIssue,
  readCheckRuns,
  startCapability,
} from "../../src/capabilityMcp.js"
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

describe("recommend_to_operator — inert and idempotent recommendations", () => {
  function recommendTool() {
    const tool = capabilityToolDefinitions({
      repoSlug: REPO,
      operatorMention: "@operator",
      capabilitySlug: "pr-health-triage",
    }).find((t) => t.name === "recommend_to_operator")
    if (!tool) throw new Error("recommend_to_operator tool missing")
    return tool
  }

  it("rejects literal @kody commands and does not touch GitHub", async () => {
    const result = await recommendTool().handler({ pr: 28, body: "Please run @kody sync --pr 28" })

    expect(result.content[0]?.text).toContain("contains implementation Kody command text")
    expect(vi.mocked(gh)).not.toHaveBeenCalled()
  })

  it("rejects kody-cmd comments and does not touch GitHub", async () => {
    const result = await recommendTool().handler({ pr: 28, body: "kody-cmd: sync --pr 28" })

    expect(result.content[0]?.text).toContain("contains implementation Kody command text")
    expect(vi.mocked(gh)).not.toHaveBeenCalled()
  })

  it("does not post when the same inert capability recommendation already exists", async () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({
          comments: [
            {
              body: [
                "@operator Please sync this PR.",
                "",
                "<!-- kody-intent: sync --pr 28 -->",
                "<!-- kody-capability: pr-health-triage -->",
              ].join("\n"),
            },
          ],
        })
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    const result = await recommendTool().handler({
      pr: 28,
      body: "Please sync this PR.\n\n<!-- kody-intent: sync --pr 28 -->",
    })

    expect(result.content[0]?.text).toBe("Recommendation already exists on PR #28; skipped.")
    const calls = vi.mocked(gh).mock.calls.map((c) => (c[0] as string[]).join(" "))
    expect(calls.some((c) => c.includes("issue comment"))).toBe(false)
  })

  it("treats legacy capability command comments as duplicates of inert intents", async () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({
          comments: [
            {
              body: [
                "@operator Please sync this PR.",
                "",
                "kody-cmd: sync --pr 28",
                "<!-- kody-capability: pr-health-triage -->",
              ].join("\n"),
            },
          ],
        })
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    const result = await recommendTool().handler({
      pr: 28,
      body: "Please sync this PR.\n\n<!-- kody-intent: sync --pr 28 -->",
    })

    expect(result.content[0]?.text).toBe("Recommendation already exists on PR #28; skipped.")
    const calls = vi.mocked(gh).mock.calls.map((c) => (c[0] as string[]).join(" "))
    expect(calls.some((c) => c.includes("issue comment"))).toBe(false)
  })

  it("posts with operator mention and capability marker when no matching recommendation exists", async () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ comments: [] })
      if (args[0] === "issue" && args[1] === "comment") return ""
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    const result = await recommendTool().handler({
      pr: 28,
      body: "Please sync this PR.\n\n<!-- kody-intent: sync --pr 28 -->",
    })

    expect(result.content[0]?.text).toBe("Recommendation posted on PR #28.")
    const commentCall = vi.mocked(gh).mock.calls.find((c) => (c[0] as string[])[1] === "comment")
    expect(commentCall).toBeDefined()
    expect(commentCall![0] as string[]).toEqual(["issue", "comment", "28", "-R", REPO, "--body-file", "-"])
    const input = (commentCall![1] as { input?: string })?.input ?? ""
    expect(input).toContain("@operator Please sync this PR.")
    expect(input).toContain("<!-- kody-intent: sync --pr 28 -->")
    expect(input).toContain("<!-- kody-capability: pr-health-triage -->")
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

describe("start_capability — public dispatch primitive", () => {
  it("starts a capability through workflow_dispatch", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "workflow" && args[1] === "run") return ""
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    expect(startCapability("kody.yml", "qa-engineer", 687)).toEqual({ ok: true })
    expect(vi.mocked(gh).mock.calls.map((c) => c[0] as string[])).toContainEqual([
      "workflow",
      "run",
      "kody.yml",
      "-f",
      "capability=qa-engineer",
      "-f",
      "issue_number=687",
    ])
  })

  it("exposes start_capability as the preferred MCP tool", async () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "workflow" && args[1] === "run") return ""
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })
    const tool = capabilityToolDefinitions({
      repoSlug: REPO,
      operatorMention: "@operator",
      capabilitySlug: "qa",
    }).find((t) => t.name === "start_capability")
    if (!tool) throw new Error("start_capability tool missing")

    const result = await tool.handler({ name: "qa-engineer", issue: 687 })

    expect(result.content[0]?.text).toBe('{"ok":true}')
    expect(vi.mocked(gh).mock.calls.map((c) => c[0] as string[])).toContainEqual([
      "workflow",
      "run",
      "kody.yml",
      "-f",
      "capability=qa-engineer",
      "-f",
      "issue_number=687",
    ])
  })

  it("dispatches child capabilities on the configured agency branch", async () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "workflow" && args[1] === "run") {
        return "https://github.com/acme/widget/actions/runs/123456"
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })
    const tool = capabilityToolDefinitions({
      repoSlug: REPO,
      operatorMention: "@operator",
      capabilitySlug: "operate-findings",
      defaultBranch: "dev",
    }).find((candidate) => candidate.name === "start_capability")
    if (!tool) throw new Error("start_capability tool missing")

    await tool.handler({ name: "dev-ci-health", issue: 687 })

    expect(vi.mocked(gh).mock.calls.map((call) => call[0] as string[])).toContainEqual([
      "workflow",
      "run",
      "kody.yml",
      "--ref",
      "dev",
      "-f",
      "capability=dev-ci-health",
    ])
  })

  it("does not forward an issue input to inputless capabilities", async () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "workflow" && args[1] === "run") {
        return "https://github.com/acme/widget/actions/runs/123456"
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })
    const tool = capabilityToolDefinitions({
      repoSlug: REPO,
      operatorMention: "@operator",
      capabilitySlug: "operate-findings",
      defaultBranch: "dev",
    }).find((candidate) => candidate.name === "start_capability")
    if (!tool) throw new Error("start_capability tool missing")

    const result = await tool.handler({ name: "dev-ci-health", issue: 55 })

    expect(result.content[0]?.text).toBe('{"ok":true,"runId":123456}')
    expect(vi.mocked(gh).mock.calls.map((call) => call[0] as string[])).toContainEqual([
      "workflow",
      "run",
      "kody.yml",
      "--ref",
      "dev",
      "-f",
      "capability=dev-ci-health",
    ])
  })
})

describe("readCheckRuns — branch CI classification", () => {
  const sha = "abc1234def"
  function mockChecks(ndjson: string) {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "api" && /\/commits\/dev$/.test(args[1] ?? "")) return sha
      if (args[0] === "api" && /check-runs$/.test(args[1] ?? "")) return ndjson
      if (args[0] === "api" && /\/status$/.test(args[1] ?? "")) return ""
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })
  }

  it("resolves the default ref from the configured agency branch", async () => {
    vi.stubEnv("GITHUB_REF_NAME", "dev")
    mockChecks(JSON.stringify({ name: "health", status: "completed", conclusion: "success", details_url: "u1" }))
    const tool = capabilityToolDefinitions({
      repoSlug: REPO,
      operatorMention: "@operator",
      defaultBranch: "main",
    }).find((candidate) => candidate.name === "read_check_runs")
    if (!tool) throw new Error("read_check_runs tool missing")

    const result = await tool.handler({ ref: "default" })

    expect(JSON.parse(result.content[0]?.text ?? "{}").sha).toBe(sha)
    vi.unstubAllEnvs()
  })

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
      [
        [
          "api",
          `repos/${REPO}/commits/${sha}/status`,
          "--jq",
          ".statuses[] | {context, state, target_url}",
        ],
        { preferRepoToken: true },
      ],
    ])
  })

  it("treats a failing commit status as RED CI evidence", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (args[0] === "api" && /\/commits\/dev$/.test(args[1] ?? "")) return sha
      if (args[0] === "api" && /check-runs$/.test(args[1] ?? "")) return ""
      if (args[0] === "api" && /\/status$/.test(args[1] ?? "")) {
        return JSON.stringify({ context: "Source Tests", state: "failure", target_url: "u-status" })
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    const result = readCheckRuns(REPO, "dev", [])

    expect(result.state).toBe("RED")
    expect(result.failing).toEqual([
      { name: "Source Tests", conclusion: "failure", detailsUrl: "u-status" },
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
