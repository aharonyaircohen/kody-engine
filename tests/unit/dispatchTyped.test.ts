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
