/**
 * Smoke tier: the lightest possible "does the engine boot and respond?"
 * checks. These spawn the real CLI end to end (no mocks) but only exercise
 * the hardcoded, side-effect-free verbs (`version`, `help`) plus argument
 * rejection — so they stay fast and need no GitHub/network access.
 *
 * If these fail, the build is fundamentally broken (bad entrypoint, broken
 * registry load, syntax error in a profile) and deeper tiers are moot.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const REPO_ROOT = process.cwd()
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx")
const ENTRY = path.join(REPO_ROOT, "bin", "kody.ts")

interface CliResult {
  status: number
  stdout: string
  stderr: string
}

function runCli(args: string[]): CliResult {
  try {
    const stdout = execFileSync(TSX, [ENTRY, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { status: 0, stdout, stderr: "" }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }
  return pkg.version
}

describe("smoke: CLI boots and responds", () => {
  it("prints a version matching package.json", () => {
    const { status, stdout } = runCli(["version"])
    expect(status).toBe(0)
    expect(stdout.trim()).toBe(`kody ${packageVersion()}`)
  })

  it("prints usage for help with the core verbs listed", () => {
    const { status, stdout } = runCli(["help"])
    expect(status).toBe(0)
    expect(stdout).toContain("single-session autonomous engineer")
    expect(stdout).toContain("Usage:")
    for (const verb of ["run", "fix", "review", "help", "version"]) {
      expect(stdout).toContain(verb)
    }
  })

  it("rejects an unknown command with a helpful message", () => {
    const { stdout, stderr } = runCli(["definitely-not-a-verb"])
    const out = stdout + stderr
    expect(out).toContain("unknown command")
    expect(out).toContain("definitely-not-a-verb")
  })
})
