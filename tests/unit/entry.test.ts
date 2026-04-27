import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseArgs } from "../../src/entry.js"

describe("entry: parseArgs", () => {
  // Isolate from GitHub Actions and chat-session env vars: parseArgs has
  // env-based shortcuts (no-args → ci when GITHUB_EVENT_NAME is set, → chat
  // when SESSION_ID is set) that are correct in production but masquerade as
  // bugs when the unit test runs in CI.
  beforeEach(() => {
    vi.stubEnv("GITHUB_EVENT_NAME", "")
    vi.stubEnv("SESSION_ID", "")
  })
  afterEach(() => {
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

  it("routes a discovered executable to __executable__", () => {
    const a = parseArgs(["run", "--issue", "42"])
    expect(a.command).toBe("__executable__")
    expect(a.executableName).toBe("run")
    expect(a.cliArgs).toEqual({ issue: "42" })
    expect(a.errors).toEqual([])
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
})
