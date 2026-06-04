/**
 * Smoke (unified job model): validates that `runJob` correctly lowers an
 * instant job (minted from a dispatch result) onto `runExecutableChain`,
 * exercising the one-runner path end-to-end with no network.
 *
 * Pattern mirrors tests/smoke/flow.test.ts — offline fixture executable,
 * KODY_SKIP_AGENT=true skips the agent, postflight records the outcome.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { mintInstantJob, runJob, validateJob } from "../../src/job.js"

let prevCwd = process.cwd()
afterEach(() => process.chdir(prevCwd))

/**
 * Scaffold a temp project with a no-agent echo executable and a minimal
 * kody.config.json (required by loadConfig in runExecutable). The executable
 * name matches the "run" dispatch so mintInstantJob sets executable:"smoke-echo"
 * and runJob dispatches to it.
 */
function makeEchoExecutable(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-smoke-job-"))
  const dir = path.join(root, ".kody", "executables", "smoke-echo")
  fs.mkdirSync(dir, { recursive: true })
  const profile = {
    name: "smoke-echo",
    role: "utility",
    describe: "offline smoke fixture: shell preflight skips the agent",
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
    scripts: { preflight: [{ shell: "skip.sh" }], postflight: [] },
  }
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile, null, 2))
  fs.writeFileSync(path.join(dir, "skip.sh"), "#!/usr/bin/env bash\necho 'KODY_SKIP_AGENT=true'\n")
  // Minimal config required by loadConfig in runExecutable
  fs.writeFileSync(
    path.join(root, "kody.config.json"),
    JSON.stringify({
      agent: { model: "claude/claude-haiku-4-5-20251001" },
      github: { owner: "test-owner", repo: "test-repo" },
      quality: {},
    }),
  )
  return root
}

describe("smoke: unified job model — instant job runs end-to-end via runJob", () => {
  it("runJob lowers a mintInstantJob dispatch result onto runExecutableChain and exits 0", async () => {
    prevCwd = process.cwd()
    const root = makeEchoExecutable()
    process.chdir(root)

    // Dispatch result simulating what the comment-router produces for `@kody run --issue 42`
    const dispatch = { executable: "smoke-echo", cliArgs: { issue: 42 }, target: 42 }
    const job = mintInstantJob(dispatch, { why: "smoke test intent" })

    expect(job.executable).toBe("smoke-echo")
    expect(job.flavor).toBe("instant")
    expect(job.cliArgs).toEqual({ issue: 42 })
    expect(job.why).toBe("smoke test intent")
    expect(job.persona).toBe("kody") // DEFAULT_INSTANT_PERSONA

    // runJob with chain:true (default) uses runExecutableChain
    const result = await runJob(job, { cwd: root, chain: true })
    expect(result.exitCode).toBe(0)
  })

  it("runJob with chain:false uses runExecutable (single-shot) — exits 0", async () => {
    prevCwd = process.cwd()
    const root = makeEchoExecutable()
    process.chdir(root)

    const dispatch = { executable: "smoke-echo", cliArgs: { issue: 1 }, target: 1 }
    const job = mintInstantJob(dispatch)

    // chain:false paths bypass runExecutableChain; used by the cron tick route
    const result = await runJob(job, { cwd: root, chain: false })
    expect(result.exitCode).toBe(0)
  })

  it("validateJob rejects a job with neither executable nor duty", () => {
    expect(() => validateJob({ cliArgs: {}, flavor: "instant" })).toThrow()
  })

  it("validateJob rejects an unknown flavor", () => {
    expect(() => validateJob({ executable: "run", cliArgs: {}, flavor: "bogus" })).toThrow()
  })
})
