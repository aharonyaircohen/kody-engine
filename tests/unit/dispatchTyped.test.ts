import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { autoDispatchTyped } from "../../src/dispatch.js"

function writeEvent(body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-dispatch-typed-"))
  const p = path.join(dir, "event.json")
  fs.writeFileSync(p, JSON.stringify(body))
  return p
}

const prev: Record<string, string | undefined> = {}

beforeEach(() => {
  prev.EVENT_NAME = process.env.GITHUB_EVENT_NAME
  prev.EVENT_PATH = process.env.GITHUB_EVENT_PATH
})

afterEach(() => {
  process.env.GITHUB_EVENT_NAME = prev.EVENT_NAME
  process.env.GITHUB_EVENT_PATH = prev.EVENT_PATH
})

describe("autoDispatchTyped: route variant", () => {
  it("returns kind=route when an explicit issue is provided", () => {
    const out = autoDispatchTyped({ explicit: { issueNumber: 42 } })
    expect(out.kind).toBe("route")
    if (out.kind === "route") {
      expect(out.executable).toBe("run")
      expect(out.target).toBe(42)
    }
  })

  it("returns kind=route for a recognized @kody <token>", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody fix", user: { login: "alice", type: "User" } },
      issue: { number: 7 },
    })
    const out = autoDispatchTyped()
    expect(out.kind).toBe("route")
    if (out.kind === "route") {
      expect(out.executable).toBe("fix")
      expect(out.target).toBe(7)
    }
  })
})

describe("autoDispatchTyped: silent variants (legitimate no-op)", () => {
  it("returns silent when no GHA event is present", () => {
    delete process.env.GITHUB_EVENT_NAME
    delete process.env.GITHUB_EVENT_PATH
    const out = autoDispatchTyped()
    expect(out.kind).toBe("silent")
    if (out.kind === "silent") expect(out.reason).toMatch(/no GHA event context/)
  })

  it("returns silent for non-issue_comment events with no work", () => {
    process.env.GITHUB_EVENT_NAME = "pull_request"
    process.env.GITHUB_EVENT_PATH = writeEvent({})
    const out = autoDispatchTyped()
    expect(out.kind).toBe("silent")
  })

  it("returns silent when comment has no @kody mention", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "looks good!", user: { login: "alice", type: "User" } },
      issue: { number: 7 },
    })
    const out = autoDispatchTyped()
    expect(out.kind).toBe("silent")
    if (out.kind === "silent") expect(out.reason).toMatch(/does not mention @kody/)
  })

  it("returns silent when comment author is a bot", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody fix", user: { login: "github-actions[bot]", type: "Bot" } },
      issue: { number: 7 },
    })
    const out = autoDispatchTyped()
    expect(out.kind).toBe("silent")
    if (out.kind === "silent") expect(out.reason).toMatch(/bot-authored/i)
  })
})

describe("autoDispatchTyped: membership gate (access.allowedAssociations)", () => {
  const teamOnly = { access: { allowedAssociations: ["OWNER", "MEMBER", "COLLABORATOR"] } } as any

  it("routes a recognized command from an allowed association (MEMBER)", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody fix", user: { login: "alice", type: "User" }, author_association: "MEMBER" },
      issue: { number: 7 },
    })
    const out = autoDispatchTyped({ config: teamOnly })
    expect(out.kind).toBe("route")
    if (out.kind === "route") expect(out.executable).toBe("fix")
  })

  it("silently ignores a blocked association even when the subcommand is real", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody fix", user: { login: "stranger", type: "User" }, author_association: "NONE" },
      issue: { number: 7 },
    })
    const out = autoDispatchTyped({ config: teamOnly })
    expect(out.kind).toBe("silent")
    if (out.kind === "silent") expect(out.reason).toMatch(/association 'NONE' not in/i)
  })

  it("treats a missing author_association as blocked when a gate is configured", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody fix", user: { login: "ghost", type: "User" } },
      issue: { number: 7 },
    })
    const out = autoDispatchTyped({ config: teamOnly })
    expect(out.kind).toBe("silent")
  })

  it("does not gate when no allowlist is configured (open default)", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody fix", user: { login: "stranger", type: "User" }, author_association: "NONE" },
      issue: { number: 7 },
    })
    const out = autoDispatchTyped()
    expect(out.kind).toBe("route")
  })
})

describe("autoDispatchTyped: unrecognized variant (user-facing feedback needed)", () => {
  it("returns unrecognized when @kody is followed by an unknown token", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody totally-not-a-real-command", user: { login: "alice", type: "User" } },
      issue: { number: 9 },
    })
    const out = autoDispatchTyped({ config: { defaultExecutable: undefined } as never })
    // No defaultExecutable for issues → legacy autoDispatch returns null →
    // typed wrapper classifies as unrecognized.
    expect(out.kind).toBe("unrecognized")
    if (out.kind === "unrecognized") {
      expect(out.token).toBe("totally-not-a-real-command")
      expect(out.target).toBe(9)
      expect(out.isPr).toBe(false)
      expect(out.available).toContain("fix")
      expect(out.available).toContain("plan")
      expect(out.available).toContain("review")
      // Watch executables (goal-/job-) are filtered out — they're internal.
      expect(out.available.find((n) => n.startsWith("goal-"))).toBeUndefined()
      expect(out.available.find((n) => n.startsWith("job-"))).toBeUndefined()
    }
  })

  // Note: PR comments unconditionally fall back to the "fix" executable in
  // legacy autoDispatch — so unrecognized-on-PR currently doesn't trigger
  // user feedback. This is a known follow-up: PRs should also surface
  // unrecognized tokens instead of silently rerouting to fix.
})

describe("autoDispatchTyped: typo'd command does NOT fall through to default executable", () => {
  it("returns unrecognized even when a default is configured (typo guard)", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody totally-not-a-real-command-035", user: { login: "alice", type: "User" } },
      issue: { number: 11 },
    })
    // Reproduces the live-tested A-Guy-educ/A-Guy bug: defaultExecutable
    // was 'classify', so any @kody comment routed there silently — a
    // typo'd command was indistinguishable from `@kody` on its own.
    const out = autoDispatchTyped({ config: { defaultExecutable: "classify" } as never })
    expect(out.kind).toBe("unrecognized")
    if (out.kind === "unrecognized") {
      expect(out.token).toBe("totally-not-a-real-command-035")
    }
  })

  it("falls through to the default for `@kody` alone (no typo to surface)", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody", user: { login: "alice", type: "User" } },
      issue: { number: 12 },
    })
    const out = autoDispatchTyped({ config: { defaultExecutable: "classify" } as never })
    expect(out.kind).toBe("route")
    if (out.kind === "route") expect(out.executable).toBe("classify")
  })

  it("falls through to the default for natural-language lead-ins (please/kindly/etc)", () => {
    for (const polite of ["please", "kindly", "hi", "hey", "thanks"]) {
      process.env.GITHUB_EVENT_NAME = "issue_comment"
      process.env.GITHUB_EVENT_PATH = writeEvent({
        comment: { body: `@kody ${polite} fix the test failure`, user: { login: "alice", type: "User" } },
        issue: { number: 13 },
      })
      const out = autoDispatchTyped({ config: { defaultExecutable: "classify" } as never })
      expect(out.kind, `polite word "${polite}"`).toBe("route")
      if (out.kind === "route") expect(out.executable).toBe("classify")
    }
  })

  it("returns unrecognized for typo'd commands even with no default (no fallback at all)", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody panl", user: { login: "alice", type: "User" } },
      issue: { number: 14 },
    })
    const out = autoDispatchTyped({ config: { defaultExecutable: undefined } as never })
    expect(out.kind).toBe("unrecognized")
    if (out.kind === "unrecognized") expect(out.token).toBe("panl")
  })

  it("returns unrecognized for typo'd commands on a PR (isPr=true)", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody fxi", user: { login: "alice", type: "User" } },
      issue: { number: 99, pull_request: { url: "https://x" } },
    })
    // Even with the hardcoded "fix" PR fallback, a non-null firstToken
    // that doesn't resolve should bail (not silently route to fix). The
    // user typed something specific; we tell them we don't know it.
    const out = autoDispatchTyped()
    expect(out.kind).toBe("unrecognized")
    if (out.kind === "unrecognized") {
      expect(out.token).toBe("fxi")
      expect(out.isPr).toBe(true)
    }
  })

  it("falls through to defaultPrExecutable for `@kody` alone on a PR", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody", user: { login: "alice", type: "User" } },
      issue: { number: 99, pull_request: { url: "https://x" } },
    })
    const out = autoDispatchTyped()
    expect(out.kind).toBe("route")
    if (out.kind === "route") expect(out.executable).toBe("fix")
  })
})
