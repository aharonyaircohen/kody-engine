/**
 * Smoke (CLI boot): spawns the real binary and checks it starts, prints its
 * identity, and rejects bad input with the documented exit code (64). These
 * are the fastest "is the build runnable at all" signals and run first in CI.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
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
    for (const verb of ["run", "resolve", "sync", "help", "version"]) {
      expect(r.stdout).toContain(verb)
    }
  })

  it("rejects an unknown command with exit 64", () => {
    const r = runCli(["definitely-not-a-verb"])
    expect(r.status).toBe(64)
    expect(r.stdout + r.stderr).toMatch(/unknown command/)
  })

  it("rejects the internal `run` implementation without --issue with exit 64", () => {
    const r = runCli(["implementation", "run"])
    expect(r.status).toBe(64)
    expect(r.stderr).toMatch(/--issue/)
  })

  it("rejects an unknown flag with exit 64", () => {
    const r = runCli(["init", "--bogus"])
    expect(r.status).toBe(64)
    expect(r.stderr).toMatch(/--bogus/)
  })

  it("scaffolds the current Kody workflow through the published CLI path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-init-cli-smoke-"))

    const r = runCli(["init", "--force"], { cwd: root })

    expect(r.status).toBe(0)
    const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "kody.yml"), "utf8")
    expect(workflow).toContain("npx -y -p @kody-ade/kody-engine@latest kody-engine")
    expect(workflow).toContain("KODY_RUN_REQUEST_JSON: ${{ inputs.runRequest }}")
    expect(workflow).toContain("cron: '7/15 * * * *'")
    expect(workflow).not.toContain("KODY_DEFINITIONS_ROOT:")
    expect(workflow).not.toContain("Hydrate Kody Store definitions")
    expect(workflow).not.toContain("actions/setup-python")
    expect(workflow).not.toContain("test -d .kody-engine/definitions/capabilities")
  })

  it("runs a project capability action through its implementation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-capability-cli-smoke-"))
    fs.writeFileSync(
      path.join(root, "kody.config.json"),
      JSON.stringify({
        quality: { typecheck: "", lint: "", format: "", testUnit: "" },
        git: { defaultBranch: "main" },
        github: { owner: "o", repo: "r" },
        agent: { model: "anthropic/test" },
      }),
    )
    const capabilityDir = path.join(root, ".kody-engine", "definitions", "capabilities", "smoke-capability")
    fs.mkdirSync(path.join(capabilityDir, "tools"), { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "contract.json"),
      JSON.stringify({
        execution: "script",
        input: { type: "object" },
        output: { type: "object" },
      }),
    )
    fs.writeFileSync(path.join(capabilityDir, "instructions.md"), "# Smoke capability\n")
    fs.writeFileSync(path.join(capabilityDir, "tools", "run.sh"), "#!/bin/sh\nprintf '{}'\n", { mode: 0o755 })

    const r = runCli(["smoke-capability"], { cwd: root })
    expect(r.status).toBe(0)
  })
})
