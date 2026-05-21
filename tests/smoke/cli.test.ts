/**
 * Smoke (CLI boot): spawns the real binary and checks it starts, prints its
 * identity, and rejects bad input with the documented exit code (64). These
 * are the fastest "is the build runnable at all" signals and run first in CI.
 */

import { describe, expect, it } from "vitest"
import { packageVersion, runCli } from "./helpers.js"

describe("smoke: CLI boots and validates args", () => {
  it("prints a version matching package.json", () => {
    const r = runCli(["version"])
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(`kody ${packageVersion()}`)
  })

  it("prints usage with the core verbs listed", () => {
    const r = runCli(["help"])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("single-session autonomous engineer")
    expect(r.stdout).toContain("Usage:")
    for (const verb of ["run", "fix", "review", "help", "version"]) {
      expect(r.stdout).toContain(verb)
    }
  })

  it("rejects an unknown command with exit 64", () => {
    const r = runCli(["definitely-not-a-verb"])
    expect(r.status).toBe(64)
    expect(r.stdout + r.stderr).toMatch(/unknown command/)
  })

  it("rejects `run` without --issue with exit 64", () => {
    const r = runCli(["run"])
    expect(r.status).toBe(64)
    expect(r.stderr).toMatch(/--issue/)
  })

  it("rejects an unknown flag with exit 64", () => {
    const r = runCli(["run", "--issue", "1", "--bogus"])
    expect(r.status).toBe(64)
    expect(r.stderr).toMatch(/--bogus/)
  })
})
