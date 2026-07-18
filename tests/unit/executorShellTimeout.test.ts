/**
 * Verifies executor.runShellEntry timeout handling:
 *   - per-entry `timeoutSec` is honored
 *   - timeout produces exit 124 with an explicit "timed out" reason
 *     (distinct from a script's own non-zero exit, which historically
 *     surfaced as "exited -1")
 *   - KODY_SHELL_TIMEOUT_SEC env var is honored when no entry override
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runImplementation } from "../../src/executor.js"

function makeFixture(opts: { exeName: string; timeoutSec?: number; sleepSec: number }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-shell-timeout-"))
  const exeDir = path.join(root, ".kody-engine", "definitions", "capabilities", opts.exeName)
  fs.mkdirSync(exeDir, { recursive: true })
  fs.writeFileSync(
    path.join(exeDir, "slow.sh"),
    `#!/usr/bin/env bash\nsleep ${opts.sleepSec}\necho "should not reach here"\n`,
    { mode: 0o755 },
  )
  const shellEntry: Record<string, unknown> = { shell: "slow.sh" }
  if (opts.timeoutSec !== undefined) shellEntry.timeoutSec = opts.timeoutSec
  const profile = {
    name: opts.exeName,
    role: "utility",
    describe: "fixture",
    kind: "oneshot",
    inputs: [],
    claudeCode: {
      model: "inherit",
      permissionMode: "acceptEdits",
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
    scripts: {
      preflight: [{ script: "skipAgent" }, shellEntry],
      postflight: [],
    },
  }
  fs.writeFileSync(path.join(exeDir, "profile.json"), JSON.stringify(profile, null, 2))
  return root
}

describe("executor: shell entry timeout", () => {
  let savedCwd: string
  let savedEnv: string | undefined

  beforeEach(() => {
    savedCwd = process.cwd()
    savedEnv = process.env.KODY_SHELL_TIMEOUT_SEC
  })

  afterEach(() => {
    process.chdir(savedCwd)
    if (savedEnv === undefined) delete process.env.KODY_SHELL_TIMEOUT_SEC
    else process.env.KODY_SHELL_TIMEOUT_SEC = savedEnv
  })

  it("times out with exit 124 and explicit reason when entry timeoutSec is exceeded", async () => {
    const root = makeFixture({ exeName: "timeout-fixture-a", timeoutSec: 1, sleepSec: 5 })
    process.chdir(root)
    const result = await runImplementation("timeout-fixture-a", {
      cliArgs: {},
      cwd: root,
      skipConfig: true,
    })
    expect(result.exitCode).toBe(124)
    expect(result.reason).toMatch(/timed out after 1s/)
    expect(result.reason).not.toMatch(/exited -1/)
  }, 10_000)

  it("respects KODY_SHELL_TIMEOUT_SEC env var when entry has no override", async () => {
    const root = makeFixture({ exeName: "timeout-fixture-b", sleepSec: 5 })
    process.chdir(root)
    process.env.KODY_SHELL_TIMEOUT_SEC = "1"
    const result = await runImplementation("timeout-fixture-b", {
      cliArgs: {},
      cwd: root,
      skipConfig: true,
    })
    expect(result.exitCode).toBe(124)
    expect(result.reason).toMatch(/timed out after 1s/)
  }, 10_000)

  // Regression: spawnSync's `timeout` option only signals the immediate
  // child — a backgrounded subshell (e.g. `gh` invoking `curl`) survives
  // past the deadline. The fix spawns bash with `detached: true` (so it's
  // its own process group leader) and signals the WHOLE group on timeout.
  // We verify by having the script schedule a delayed `touch leaked.marker`
  // in a backgrounded subshell, then sleep forever. If the group is killed
  // properly, the marker never appears.
  it("kills backgrounded descendants on timeout (process group)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-shell-timeout-pg-"))
    const exeName = "timeout-fixture-pg"
    const exeDir = path.join(root, ".kody-engine", "definitions", "capabilities", exeName)
    fs.mkdirSync(exeDir, { recursive: true })
    const markerPath = path.join(root, "leaked.marker")
    fs.writeFileSync(
      path.join(exeDir, "leak.sh"),
      `#!/usr/bin/env bash\n( sleep 3; touch "${markerPath}" ) &\nsleep 30\n`,
      { mode: 0o755 },
    )
    const profile = {
      name: exeName,
      role: "utility",
      describe: "fixture",
      kind: "oneshot",
      inputs: [],
      claudeCode: {
        model: "inherit",
        permissionMode: "acceptEdits",
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
      scripts: {
        preflight: [{ script: "skipAgent" }, { shell: "leak.sh", timeoutSec: 1 }],
        postflight: [],
      },
    }
    fs.writeFileSync(path.join(exeDir, "profile.json"), JSON.stringify(profile, null, 2))

    process.chdir(root)
    const result = await runImplementation(exeName, { cliArgs: {}, cwd: root, skipConfig: true })
    expect(result.exitCode).toBe(124)

    // Wait past when the leaked descendant would have written the marker.
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    expect(fs.existsSync(markerPath)).toBe(false)
  }, 15_000)
})
