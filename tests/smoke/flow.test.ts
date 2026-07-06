/**
 * Smoke (offline flow): the one test that drives a real flow end to end
 * through the executor with zero network. A fixture implementation's shell
 * preflight emits KODY_SKIP_AGENT=true, so the executor runs
 * preflight -> (agent skipped) -> postflight (recordOutcome) and returns
 * exit 0. If the executor pipeline is broken — preflight wiring, the
 * skip-agent seam, postflight dispatch — this fails without needing GitHub,
 * an API key, or a real repo.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runImplementation } from "../../src/executor.js"

let prevCwd = process.cwd()
afterEach(() => process.chdir(prevCwd))

/** Scaffold a temp project with a no-agent echo implementation. Returns its root. */
function makeEchoImplementation(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-smoke-flow-"))
  const dir = path.join(root, ".kody", "capabilities", "smoke-echo")
  fs.mkdirSync(dir, { recursive: true })
  const profile = {
    name: "smoke-echo",
    role: "utility",
    describe: "offline smoke-flow fixture: shell preflight skips the agent",
    kind: "oneshot",
    inputs: [{ name: "issue", flag: "--issue", type: "int", required: true, describe: "ignored" }],
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
    scripts: { preflight: [{ shell: "skip.sh" }], postflight: [{ script: "recordOutcome" }] },
  }
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile, null, 2))
  fs.writeFileSync(path.join(dir, "capability.md"), "# Smoke echo\n")
  fs.writeFileSync(path.join(dir, "skip.sh"), "#!/usr/bin/env bash\necho 'KODY_SKIP_AGENT=true'\n")
  return root
}

describe("smoke: offline flow through the executor", () => {
  it("runs preflight -> skip-agent -> postflight and exits 0 with no network", async () => {
    prevCwd = process.cwd()
    const root = makeEchoImplementation()
    process.chdir(root)
    const result = await runImplementation("smoke-echo", {
      cliArgs: { issue: 1 },
      cwd: root,
      skipConfig: true,
    })
    expect(result.exitCode).toBe(0)
  })
})
