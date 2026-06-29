import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import { autoDispatchTyped } from "../../src/dispatch.js"

function writeEvent(body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-dispatch-typed-"))
  const p = path.join(dir, "event.json")
  fs.writeFileSync(p, JSON.stringify(body))
  return p
}

function testConfig(config: Partial<KodyConfig>): KodyConfig {
  return config as KodyConfig
}

const prev: Record<string, string | undefined> = {}

let fixtureRoot: string
let prevCwd: string

beforeAll(() => {
  // sync/resolve/merge/fix-ci ship in kody-store, not the engine root. CI
  // clones the store alongside the repo; locally that clone may be missing,
  // so write minimal stub capability folders and chdir into the fixture so
  // the registry picks them up regardless of whether the store is present.
  prevCwd = process.cwd()
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kody-dispatch-typed-fixtures-"))
  for (const slug of ["sync", "resolve", "merge", "fix-ci"]) {
    const dir = path.join(fixtureRoot, ".kody", "capabilities", slug)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "profile.json"),
      JSON.stringify({
        name: slug,
        action: slug,
        agentAction: slug,
        capabilityKind: "act",
        role: "primitive",
        describe: `Stub ${slug} capability for dispatchTyped tests.`,
      }),
    )
    fs.writeFileSync(path.join(dir, "capability.md"), `# ${slug}\n`)
  }
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
      comment: { body: "@kody run", user: { login: "alice", type: "User" } },
      issue: { number: 7 },
    })
    const out = autoDispatchTyped()
    expect(out.kind).toBe("route")
    if (out.kind === "route") {
      expect(out.executable).toBe("run")
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

  it("returns silent for a @kody substring that is NOT a real mention (e.g. an email)", () => {
    // Live-test regression (v0.4.199): `me@kody.dev` contains the substring
    // "@kody" but is not a mention. autoDispatchTyped used `.includes("@kody")`
    // and then extracted the comment's first word ("ping") as a subcommand,
    // posting a stray "I don't recognize `ping`" reply. Must be silent.
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "ping me@kody.dev when ready", user: { login: "alice", type: "User" } },
      issue: { number: 7 },
    })
    const out = autoDispatchTyped()
    expect(out.kind).toBe("silent")
    if (out.kind === "silent") expect(out.reason).toMatch(/does not mention @kody/)
  })

  it("returns silent for '@kodyfix' (no boundary after @kody)", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kodyfix please", user: { login: "alice", type: "User" } },
      issue: { number: 7 },
    })
    expect(autoDispatchTyped().kind).toBe("silent")
  })

  it("routes an explicit @kody command even from a bot (self-dispatch)", () => {
    // Kody runs as a bot when the repo token is a GitHub App; capabilities and
    // flows self-dispatch by posting `@kody <command>`. An explicit, resolved
    // command must be honored, not dropped as "bot chatter".
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody run", user: { login: "kodyade[bot]", type: "Bot" } },
      issue: { number: 7, pull_request: {} },
    })
    const out = autoDispatchTyped()
    expect(out.kind).toBe("route")
    if (out.kind === "route") expect(out.executable).toBe("run")
  })

  it("returns silent for bot chatter without an explicit command", () => {
    // A bot comment that doesn't resolve to a command (status/progress text)
    // is still dropped — that's the loop guard for Kody's own comments.
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody looks good, shipping now", user: { login: "kodyade[bot]", type: "Bot" } },
      issue: { number: 7 },
    })
    const out = autoDispatchTyped()
    expect(out.kind).toBe("silent")
  })
})

describe("autoDispatchTyped: membership gate (access.allowedAssociations)", () => {
  const teamOnly = testConfig({ access: { allowedAssociations: ["OWNER", "MEMBER", "COLLABORATOR"] } })

  it("routes a recognized command from an allowed association (MEMBER)", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody run", user: { login: "alice", type: "User" }, author_association: "MEMBER" },
      issue: { number: 7 },
    })
    const out = autoDispatchTyped({ config: teamOnly })
    expect(out.kind).toBe("route")
    if (out.kind === "route") expect(out.executable).toBe("run")
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

  it("does not gate when dispatch is called without a config (allowlist enforced only when present)", () => {
    // The team-only default lives in loadConfig; dispatch's rule is "allowlist
    // present → enforce, absent → open". Callers that pass no config (tests,
    // legacy paths) therefore route freely — production always loads config.
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody run", user: { login: "stranger", type: "User" }, author_association: "NONE" },
      issue: { number: 7 },
    })
    const out = autoDispatchTyped()
    expect(out.kind).toBe("route")
  })

  it("reopens to everyone when config sets an explicit empty allowlist", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody run", user: { login: "stranger", type: "User" }, author_association: "NONE" },
      issue: { number: 7 },
    })
    const out = autoDispatchTyped({ config: testConfig({ access: { allowedAssociations: [] } }) })
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
      expect(out.available).toContain("run")
      expect(out.available).toContain("resolve")
      expect(out.available).toContain("merge")
      // Watch executables (goal-/job-) are filtered out — they're internal.
      expect(out.available.find((n) => n.startsWith("goal-"))).toBeUndefined()
      expect(out.available.find((n) => n.startsWith("job-"))).toBeUndefined()
    }
  })

  it("returns unrecognized for typo'd commands on a PR when no PR default is configured", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody totally-not-a-real-command", user: { login: "alice", type: "User" } },
      issue: { number: 9, pull_request: {} },
    })
    const out = autoDispatchTyped({ config: { defaultPrExecutable: undefined } as never })
    expect(out.kind).toBe("unrecognized")
    if (out.kind === "unrecognized") {
      expect(out.token).toBe("totally-not-a-real-command")
      expect(out.target).toBe(9)
      expect(out.isPr).toBe(true)
    }
  })
})

describe("autoDispatchTyped: typo'd command does NOT fall through to default capability action", () => {
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
    const out = autoDispatchTyped({ config: { defaultExecutable: "run" } as never })
    expect(out.kind).toBe("route")
    if (out.kind === "route") expect(out.executable).toBe("run")
  })

  it("falls through to the default for natural-language lead-ins (please/kindly/etc)", () => {
    for (const polite of ["please", "kindly", "hi", "hey", "thanks"]) {
      process.env.GITHUB_EVENT_NAME = "issue_comment"
      process.env.GITHUB_EVENT_PATH = writeEvent({
        comment: { body: `@kody ${polite} fix the test failure`, user: { login: "alice", type: "User" } },
        issue: { number: 13 },
      })
      const out = autoDispatchTyped({ config: { defaultExecutable: "run" } as never })
      expect(out.kind, `polite word "${polite}"`).toBe("route")
      if (out.kind === "route") expect(out.executable).toBe("run")
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
    // A non-null firstToken that doesn't resolve should bail. The user typed
    // something specific; we tell them we don't know it.
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
    const out = autoDispatchTyped({ config: { defaultPrExecutable: "sync" } as never })
    expect(out.kind).toBe("route")
    if (out.kind === "route") expect(out.executable).toBe("sync")
  })
})
