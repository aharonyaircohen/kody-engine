import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const brainServeMock = vi.hoisted(() => vi.fn(async () => 0))

vi.mock("../../src/servers/brain-serve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/servers/brain-serve.js")>()),
  brainServe: brainServeMock,
}))

import { main, parseArgs } from "../../src/entry.js"

describe("entry: parseArgs", () => {
  // Isolate from GitHub Actions and chat-session env vars: parseArgs has
  // env-based shortcuts (no-args → ci when GITHUB_EVENT_NAME is set, → chat
  // when SESSION_ID is set) that are correct in production but masquerade as
  // bugs when the unit test runs in CI.
  beforeEach(() => {
    vi.stubEnv("GITHUB_EVENT_NAME", "")
    vi.stubEnv("SESSION_ID", "")
    vi.stubEnv("KODY_RUN_MODE", "")
    vi.stubEnv("KODY_RUN_REQUEST_JSON", "")
    vi.stubEnv("ISSUE_NUMBER", "")
  })
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it("returns help when no args", () => {
    expect(parseArgs([]).command).toBe("help")
  })

  it("recognizes help variants", () => {
    expect(parseArgs(["help"]).command).toBe("help")
    expect(parseArgs(["--help"]).command).toBe("help")
    expect(parseArgs(["-h"]).command).toBe("help")
  })

  it("recognizes version variants", () => {
    expect(parseArgs(["version"]).command).toBe("version")
    expect(parseArgs(["--version"]).command).toBe("version")
    expect(parseArgs(["-v"]).command).toBe("version")
  })

  it("routes a discovered public action to __capability__", () => {
    const a = parseArgs(["run", "--issue", "42"])
    expect(a.command).toBe("__capability__")
    expect(a.actionName).toBe("run")
    expect(a.cliArgs).toEqual({ issue: "42" })
    expect(a.errors).toEqual([])
  })

  it("routes explicit implementation runner to __implementation__", () => {
    const a = parseArgs(["implementation", "run", "--issue", "42", "--quiet"])
    expect(a.command).toBe("__implementation__")
    expect(a.implementationName).toBe("run")
    expect(a.quiet).toBe(true)
    expect(a.cliArgs).toEqual({ issue: "42", quiet: true })
    expect(a.errors).toEqual([])
  })

  it("routes exec alias to __implementation__", () => {
    const a = parseArgs(["exec", "run", "--issue", "42"])
    expect(a.command).toBe("__implementation__")
    expect(a.implementationName).toBe("run")
    expect(a.cliArgs).toEqual({ issue: "42" })
    expect(a.errors).toEqual([])
  })

  it("rejects implementation without a name", () => {
    const a = parseArgs(["implementation", "--quiet"])
    expect(a.errors).toEqual(["implementation requires a name"])
  })

  it("rejects exec without a name", () => {
    const a = parseArgs(["exec", "--quiet"])
    expect(a.errors).toEqual(["exec requires a name"])
  })

  it("parses --verbose / --quiet flags through the generic parser", () => {
    const a = parseArgs(["run", "--issue", "1", "--verbose"])
    expect(a.verbose).toBe(true)
    expect(a.cliArgs?.issue).toBe("1")
    expect(a.cliArgs?.verbose).toBe(true)
  })

  it("parses --cwd", () => {
    const a = parseArgs(["run", "--issue", "1", "--cwd", "/tmp/foo"])
    expect(a.cwd).toBe("/tmp/foo")
  })

  it("rejects unknown commands", () => {
    const a = parseArgs(["frobnicate"])
    expect(a.errors.length).toBeGreaterThan(0)
    expect(a.errors[0]).toContain("unknown command")
  })

  it("routes ci to its own branch", () => {
    const a = parseArgs(["ci", "--issue", "1"])
    expect(a.command).toBe("ci")
    expect(a.ciArgv).toEqual(["--issue", "1"])
  })

  it("routes bare runner issue mode through ci preflight", () => {
    vi.stubEnv("KODY_RUN_MODE", "issue")
    vi.stubEnv("ISSUE_NUMBER", "42")

    const a = parseArgs([])

    expect(a.command).toBe("ci")
    expect(a.ciArgv).toEqual(["--issue", "42"])
  })

  it("routes bare runner issue requests through ci preflight", () => {
    vi.stubEnv(
      "KODY_RUN_REQUEST_JSON",
      JSON.stringify({
        target: { type: "issue", id: 42 },
        intent: "run",
        source: "dashboard",
      }),
    )

    const a = parseArgs([])

    expect(a.command).toBe("ci")
    expect(a.ciArgv).toEqual(["--issue", "42"])
  })

  it("routes bare runner chat requests to chat", () => {
    vi.stubEnv(
      "KODY_RUN_REQUEST_JSON",
      JSON.stringify({
        target: { type: "chat", id: "sess-1" },
        intent: "continue",
        source: "dashboard",
      }),
    )

    const a = parseArgs([])

    expect(a.command).toBe("chat")
    expect(a.chatArgv).toEqual([])
  })

  it("routes bare runner goal requests to ci", () => {
    vi.stubEnv(
      "KODY_RUN_REQUEST_JSON",
      JSON.stringify({
        target: { type: "goal", id: "weekly-docs" },
        intent: "manage",
        source: "dashboard",
      }),
    )

    const a = parseArgs([])

    expect(a.command).toBe("ci")
    expect(a.ciArgv).toEqual([])
  })

  it("routes bare runner interactive mode to chat", () => {
    vi.stubEnv("KODY_RUN_MODE", "interactive")

    const a = parseArgs([])

    expect(a.command).toBe("chat")
    expect(a.chatArgv).toEqual([])
  })

  it("routes bare runner scheduled mode to ci", () => {
    vi.stubEnv("KODY_RUN_MODE", "scheduled")

    const a = parseArgs([])

    expect(a.command).toBe("ci")
    expect(a.ciArgv).toEqual([])
  })

  it("starts a repo-less Brain without global definition hydration", async () => {
    vi.stubEnv("CONVEX_URL", "https://example.convex.cloud")
    vi.stubEnv("KODY_SERVICE_KEY", "service-key")
    vi.stubEnv("GITHUB_REPOSITORY", "")

    await expect(main(["brain-serve"])).resolves.toBe(0)
    expect(brainServeMock).toHaveBeenCalledTimes(1)
  })
})
