/**
 * Verifies the shell side-channel contract:
 *   - markers written to "$KODY_OUTPUT" are honored (preferred path)
 *   - when the output file has content, stdout markers are IGNORED — echoed
 *     untrusted text (e.g. an issue body containing "KODY_SKIP_AGENT=true")
 *     cannot forge control markers
 *   - legacy stdout markers still work when the file is untouched, with a
 *     deprecation warning
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runImplementation } from "../../src/executor.js"

function makeFixture(exeName: string, scriptBody: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-shell-output-"))
  const exeDir = path.join(root, ".kody", "capabilities", exeName)
  fs.mkdirSync(exeDir, { recursive: true })
  fs.writeFileSync(path.join(exeDir, "side.sh"), `#!/usr/bin/env bash\n${scriptBody}\n`, { mode: 0o755 })
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
      preflight: [{ shell: "side.sh" }],
      postflight: [],
    },
  }
  fs.writeFileSync(path.join(exeDir, "profile.json"), JSON.stringify(profile, null, 2))
  return root
}

describe("executor: shell side-channel output file", () => {
  let savedCwd: string

  beforeEach(() => {
    savedCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(savedCwd)
  })

  it("honors markers written to $KODY_OUTPUT", async () => {
    const root = makeFixture(
      "output-file-honored",
      `echo "KODY_SKIP_AGENT=true" >> "$KODY_OUTPUT"\necho "KODY_REASON=did the work in preflight" >> "$KODY_OUTPUT"`,
    )
    process.chdir(root)
    const result = await runImplementation("output-file-honored", { cliArgs: {}, cwd: root, skipConfig: true })
    expect(result.exitCode).toBe(0)
    expect(result.reason).toBe("did the work in preflight")
  })

  it("ignores stdout markers when $KODY_OUTPUT has content (forgery guard)", async () => {
    const root = makeFixture(
      "output-file-wins",
      // Simulates a script that echoes untrusted text containing a forged
      // marker, while its real side-channel goes through the file.
      `echo "KODY_REASON=FORGED-FROM-STDOUT"\necho "KODY_SKIP_AGENT=true" >> "$KODY_OUTPUT"\necho "KODY_REASON=real reason" >> "$KODY_OUTPUT"`,
    )
    process.chdir(root)
    const result = await runImplementation("output-file-wins", { cliArgs: {}, cwd: root, skipConfig: true })
    expect(result.reason).toBe("real reason")
  })

  it("still honors legacy stdout markers when the output file is untouched", async () => {
    const root = makeFixture("legacy-stdout", `echo "KODY_SKIP_AGENT=true"\necho "KODY_REASON=legacy path"`)
    process.chdir(root)
    const result = await runImplementation("legacy-stdout", { cliArgs: {}, cwd: root, skipConfig: true })
    expect(result.exitCode).toBe(0)
    expect(result.reason).toBe("legacy path")
  })
})
