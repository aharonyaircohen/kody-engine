/**
 * Unit tests for the `runTickScript` preflight (deterministic agent-responsibility-tick).
 *
 * These exercise the contract that motivated the code's existence: when a
 * agentResponsibility declares `tickScript` in profile.json, the script's stdout is the
 * single source of truth for next-state — no LLM in the loop. Earlier
 * regressions silently dropped state because the agent didn't echo the
 * fenced block, so we pin:
 *   - happy path persists nextJobState parsed from stdout
 *   - missing tickScript field fails loudly (not silently)
 *   - non-zero script exit propagates
 *   - missing fenced block sets nextStateParseError (writeJobStateFile guards)
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/agent-actions/types.js"
import { runTickScript } from "../../src/scripts/runTickScript.js"

function configFor(): KodyConfig {
  return {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "acme", repo: "widgets" },
    agent: { model: "anthropic/test" },
    // local-file backend writes/reads `.kody/jobs/<slug>/state.json`
    // synchronously — no network, suitable for unit tests.
    jobs: { stateBackend: "local-file" },
  }
}

function ctxFor(cwd: string, slug: string): Context {
  return {
    args: { job: slug },
    cwd,
    config: configFor(),
    data: {},
    output: { exitCode: 0 },
  }
}

const PROFILE = {} as unknown as Profile

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runTickScript-"))
  fs.mkdirSync(path.join(tmp, ".kody", "jobs"), { recursive: true })
  fs.mkdirSync(path.join(tmp, ".kody", "scripts"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeJob(slug: string, profile: Record<string, unknown>, body = "# job\n"): void {
  const dir = path.join(tmp, ".kody", "jobs", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "agent-responsibility.md"), body)
}

function writeScript(rel: string, contents: string): void {
  const abs = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents)
  fs.chmodSync(abs, 0o755)
}

describe("runTickScript", () => {
  it("parses next-state from script stdout into ctx.data.nextJobState", async () => {
    writeJob("demo", { tickScript: ".kody/scripts/demo.sh" })
    writeScript(
      ".kody/scripts/demo.sh",
      `#!/usr/bin/env bash
echo "noise before"
cat <<'EOF'
\`\`\`kody-job-next-state
{ "cursor": "tick-1", "data": { "perPr": { "42": { "lastSha": "abc", "attempts": 1 } } }, "done": false }
\`\`\`
EOF
`,
    )

    const ctx = ctxFor(tmp, "demo")
    await runTickScript(ctx, PROFILE, { jobsDir: ".kody/jobs", slugArg: "job" })

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.data.nextStateParseError).toBeUndefined()
    const next = ctx.data.nextJobState as { cursor: string; data: { perPr: Record<string, unknown> } }
    expect(next.cursor).toBe("tick-1")
    expect(next.data.perPr["42"]).toEqual({ lastSha: "abc", attempts: 1 })
  })

  it("fails loudly when the profile has no tickScript", async () => {
    writeJob("demo", { every: "1h" })

    const ctx = ctxFor(tmp, "demo")
    await runTickScript(ctx, PROFILE, { jobsDir: ".kody/jobs", slugArg: "job" })

    expect(ctx.output.exitCode).toBe(99)
    expect(ctx.output.reason).toMatch(/tickScript/i)
  })

  it("propagates a non-zero script exit", async () => {
    writeJob("demo", { tickScript: ".kody/scripts/fail.sh" })
    writeScript(".kody/scripts/fail.sh", "#!/usr/bin/env bash\nexit 7\n")

    const ctx = ctxFor(tmp, "demo")
    await runTickScript(ctx, PROFILE, { jobsDir: ".kody/jobs", slugArg: "job" })

    expect(ctx.output.exitCode).toBe(7)
    expect(ctx.data.nextJobState).toBeUndefined()
  })

  it("sets nextStateParseError when stdout omits the fenced block", async () => {
    writeJob("demo", { tickScript: ".kody/scripts/silent.sh" })
    writeScript(".kody/scripts/silent.sh", "#!/usr/bin/env bash\necho 'no fence here'\n")

    const ctx = ctxFor(tmp, "demo")
    await runTickScript(ctx, PROFILE, { jobsDir: ".kody/jobs", slugArg: "job" })

    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.data.nextStateParseError).toMatch(/missing.*kody-job-next-state/)
  })

  it("does not truncate stdout above Node's 1MB default — 2MB preamble + fence still parses", async () => {
    // Pins the maxBuffer fix. Without `maxBuffer: 16MB` on spawnSync,
    // stdout >1MB is silently truncated and the fenced block at the end
    // is dropped — the exact "silent state drop" failure mode this
    // agentAction was written to prevent. The script writes ~2MB of
    // preamble, then the fenced block.
    writeJob("demo", { tickScript: ".kody/scripts/big.sh" })
    writeScript(
      ".kody/scripts/big.sh",
      `#!/usr/bin/env bash
# Roughly 2MB of filler — well above Node's 1MB spawnSync default.
yes "noisy line for buffer test" | head -n 50000
cat <<'EOF'
\`\`\`kody-job-next-state
{ "cursor": "tick-big", "data": { "size": "2mb" }, "done": false }
\`\`\`
EOF
`,
    )

    const ctx = ctxFor(tmp, "demo")
    await runTickScript(ctx, PROFILE, { jobsDir: ".kody/jobs", slugArg: "job" })

    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.data.nextStateParseError).toBeUndefined()
    const next = ctx.data.nextJobState as { cursor: string; data: { size: string } }
    expect(next.cursor).toBe("tick-big")
    expect(next.data.size).toBe("2mb")
  })

  it("reports timeout via signal, not a misleading null exit", async () => {
    // Pins the signal-aware timeout branch. Without it, a hung script
    // bubbles up as `exited null` and operators can't tell timeout from
    // exec failure. We override the 5min default by triggering a SIGTERM
    // explicitly — `spawnSync`'s `timeout` option is the same code path.
    writeJob("demo", { tickScript: ".kody/scripts/hang.sh" })
    // `kill -SIGTERM $$` simulates what `timeout: ...` does to a hung
    // script, without making the test wait 5 minutes.
    writeScript(".kody/scripts/hang.sh", "#!/usr/bin/env bash\nkill -SIGTERM $$\nsleep 30\n")

    const ctx = ctxFor(tmp, "demo")
    await runTickScript(ctx, PROFILE, { jobsDir: ".kody/jobs", slugArg: "job" })

    expect(ctx.output.exitCode).toBe(124)
    expect(ctx.output.reason).toMatch(/killed by SIGTERM/)
  })

  it("does not leak parent secrets into the script's env", async () => {
    // Pins the curated-env allow-list. Without it, KODY_MASTER_KEY and
    // similar secrets from the runner would be visible to any tick
    // script — a footgun amplified by `set -x`. The script echoes its
    // env into the fenced data block; we assert the secret is absent
    // and that allow-listed vars (PATH, GH_TOKEN) survive.
    writeJob("demo", { tickScript: ".kody/scripts/env.sh" })
    // Heredoc is QUOTED so backticks don't run as command substitution;
    // we emit the JSON via a single printf (variable interpolation
    // explicit) instead of mixing variable refs into the fenced block.
    writeScript(
      ".kody/scripts/env.sh",
      `#!/usr/bin/env bash
secret_present=$([ -n "\${KODY_MASTER_KEY:-}" ] && echo true || echo false)
gh_present=$([ -n "\${GH_TOKEN:-}" ] && echo true || echo false)
path_present=$([ -n "\${PATH:-}" ] && echo true || echo false)
printf '%s\\n' '\`\`\`kody-job-next-state'
printf '{ "cursor": "env-tick", "data": { "secret": %s, "gh": %s, "path": %s }, "done": false }\\n' \\
  "$secret_present" "$gh_present" "$path_present"
printf '%s\\n' '\`\`\`'
`,
    )

    const prevSecret = process.env.KODY_MASTER_KEY
    const prevGh = process.env.GH_TOKEN
    process.env.KODY_MASTER_KEY = "test-vault-secret-do-not-leak"
    process.env.GH_TOKEN = "test-gh-token"
    try {
      const ctx = ctxFor(tmp, "demo")
      await runTickScript(ctx, PROFILE, { jobsDir: ".kody/jobs", slugArg: "job" })

      expect(ctx.output.exitCode).toBe(0)
      const next = ctx.data.nextJobState as { data: { secret: boolean; gh: boolean; path: boolean } }
      expect(next.data.secret).toBe(false)
      expect(next.data.gh).toBe(true)
      expect(next.data.path).toBe(true)
    } finally {
      if (prevSecret === undefined) delete process.env.KODY_MASTER_KEY
      else process.env.KODY_MASTER_KEY = prevSecret
      if (prevGh === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = prevGh
    }
  })
})
