import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { loadProfile } from "../../src/profile.js"
import { resolveImplementation } from "../../src/registry.js"

function ciCheckProfilePath(): string {
  const resolved = resolveImplementation("ci-check")
  if (!resolved) throw new Error("ci-check implementation not found")
  return resolved
}

function ciCheckScriptPath(): string {
  const profilePath = ciCheckProfilePath()
  const profile = loadProfile(profilePath)
  const shell = profile.scripts.preflight.find((step) => step.shell)?.shell
  if (!shell) throw new Error("ci-check shell is not declared")
  return path.join(path.dirname(profilePath), shell)
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-ci-check-"))
}

function runCiCheck(checks: unknown): string {
  const dir = tmpDir()
  const bin = path.join(dir, "bin")
  fs.mkdirSync(bin)
  const fixture = path.join(dir, "checks.json")
  fs.writeFileSync(fixture, JSON.stringify(checks), "utf8")
  const gh = path.join(bin, "gh")
  fs.writeFileSync(
    gh,
    [
      "#!/usr/bin/env bash",
      'if [[ "$1" == "pr" && "$2" == "checks" ]]; then',
      '  cat "$GH_FIXTURE"',
      "  exit 0",
      "fi",
      "echo unexpected gh call >&2",
      "exit 2",
      "",
    ].join("\n"),
    "utf8",
  )
  fs.chmodSync(gh, 0o755)

  return execFileSync("bash", [ciCheckScriptPath()], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      GH_FIXTURE: fixture,
      KODY_ARG_PR: "123",
      KODY_ARG_GOAL: "release-aguy",
      KODY_ARG_EVIDENCE: "mainDeployPrGreen",
      KODY_ARG_TIMEOUT_SECONDS: "0",
    },
  })
}

describe("ci-check implementation", () => {
  it("loads the implementation profile", () => {
    const implementation = loadProfile(ciCheckProfilePath())

    expect(implementation.name).toBe("ci-check")
    expect(implementation.scripts.postflight.map((entry) => entry.script)).toContain("applyCapabilityReports")
  })

  it("reports requested evidence true when every CI check is green", () => {
    const output = runCiCheck([
      { name: "unit", workflow: "test", bucket: "pass", state: "SUCCESS" },
      { name: "lint", workflow: "lint", bucket: "pass", state: "SUCCESS" },
    ])

    expect(output).toContain(
      'KODY_CAPABILITY_REPORT={"target":{"type":"goal","id":"release-aguy"},"evidence":{"mainDeployPrGreen":true},"facts":{"pr":123,"ciStatus":"green","ciChecks":2}}',
    )
    expect(output).toContain(
      'KODY_CAPABILITY_RESULT={"version":1,"status":"pass","summary":"CI green on PR #123 (2 checks)","facts":{"pr":123,"ciStatus":"green","ciChecks":2}}',
    )
    expect(output).toContain("KODY_REASON=CI green on PR #123")
    expect(output).toContain("KODY_SKIP_AGENT=true")
  })

  it("reports requested evidence false when CI is still pending", () => {
    const output = runCiCheck([{ name: "unit", workflow: "test", bucket: "pending", state: "IN_PROGRESS" }])

    expect(output).toContain(
      'KODY_CAPABILITY_REPORT={"target":{"type":"goal","id":"release-aguy"},"evidence":{"mainDeployPrGreen":false},"facts":{"pr":123,"ciStatus":"pending","ciChecks":1,"ciPending":1,"ciDetail":"test"}}',
    )
    expect(output).toContain(
      'KODY_CAPABILITY_RESULT={"version":1,"status":"blocked","summary":"CI pending on PR #123: test","facts":{"pr":123,"ciStatus":"pending","ciChecks":1,"ciPending":1,"ciDetail":"test"}}',
    )
    expect(output).toContain("KODY_REASON=CI pending on PR #123")
  })
})
