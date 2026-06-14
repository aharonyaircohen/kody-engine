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

  it("runs a project duty action through its implementation executable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-duty-cli-smoke-"))
    fs.mkdirSync(path.join(root, ".kody", "duties"), { recursive: true })
    fs.mkdirSync(path.join(root, ".kody", "executables", "smoke-impl"), { recursive: true })
    fs.writeFileSync(
      path.join(root, "kody.config.json"),
      JSON.stringify({
        quality: { typecheck: "", lint: "", format: "", testUnit: "" },
        git: { defaultBranch: "main" },
        github: { owner: "o", repo: "r" },
        agent: { model: "anthropic/test" },
      }),
    )
    fs.mkdirSync(path.join(root, ".kody", "duties", "smoke-duty"), { recursive: true })
    fs.writeFileSync(
      path.join(root, ".kody", "duties", "smoke-duty", "profile.json"),
      JSON.stringify({ name: "smoke-duty", action: "smoke-action", executable: "smoke-impl", staff: "kody" }),
    )
    fs.writeFileSync(path.join(root, ".kody", "duties", "smoke-duty", "duty.md"), "# Smoke\n")
    fs.writeFileSync(
      path.join(root, ".kody", "executables", "smoke-impl", "profile.json"),
      JSON.stringify({
        name: "smoke-impl",
        role: "utility",
        describe: "smoke impl",
        kind: "oneshot",
        inputs: [],
        claudeCode: {
          model: "inherit",
          permissionMode: "default",
          maxTurns: 0,
          maxThinkingTokens: null,
          systemPromptAppend: null,
          tools: [],
          hooks: [],
          skills: [],
          commands: [],
          subagents: [],
          plugins: [],
          mcpServers: [],
        },
        cliTools: [],
        scripts: { preflight: [{ script: "skipAgent" }], postflight: [] },
      }),
    )

    const r = runCli(["smoke-action"], { cwd: root })
    expect(r.status).toBe(0)
  })
})
