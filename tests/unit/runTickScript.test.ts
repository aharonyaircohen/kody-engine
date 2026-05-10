/**
 * Unit tests for the `runTickScript` preflight (deterministic job-tick).
 *
 * These exercise the contract that motivated the code's existence: when a
 * job declares `tickScript:` in frontmatter, the script's stdout is the
 * single source of truth for next-state — no LLM in the loop. Earlier
 * regressions silently dropped state because the agent didn't echo the
 * fenced block, so we pin:
 *   - happy path persists nextJobState parsed from stdout
 *   - missing tickScript frontmatter fails loudly (not silently)
 *   - non-zero script exit propagates
 *   - missing fenced block sets nextStateParseError (writeJobStateFile guards)
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { runTickScript } from "../../src/scripts/runTickScript.js"

function configFor(): KodyConfig {
  return {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "acme", repo: "widgets" },
    agent: { model: "anthropic/test" },
    // local-file backend writes/reads `.kody/jobs/<slug>.state.json`
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

function writeJob(slug: string, frontmatter: string, body = "# job\n"): void {
  const fm = frontmatter ? `---\n${frontmatter}\n---\n` : ""
  fs.writeFileSync(path.join(tmp, ".kody", "jobs", `${slug}.md`), fm + body)
}

function writeScript(rel: string, contents: string): void {
  const abs = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents)
  fs.chmodSync(abs, 0o755)
}

describe("runTickScript", () => {
  it("parses next-state from script stdout into ctx.data.nextJobState", async () => {
    writeJob("demo", "tickScript: .kody/scripts/demo.sh")
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

  it("fails loudly when frontmatter has no tickScript", async () => {
    writeJob("demo", "every: 1h")

    const ctx = ctxFor(tmp, "demo")
    await runTickScript(ctx, PROFILE, { jobsDir: ".kody/jobs", slugArg: "job" })

    expect(ctx.output.exitCode).toBe(99)
    expect(ctx.output.reason).toMatch(/tickScript/i)
  })

  it("propagates a non-zero script exit", async () => {
    writeJob("demo", "tickScript: .kody/scripts/fail.sh")
    writeScript(".kody/scripts/fail.sh", "#!/usr/bin/env bash\nexit 7\n")

    const ctx = ctxFor(tmp, "demo")
    await runTickScript(ctx, PROFILE, { jobsDir: ".kody/jobs", slugArg: "job" })

    expect(ctx.output.exitCode).toBe(7)
    expect(ctx.data.nextJobState).toBeUndefined()
  })

  it("sets nextStateParseError when stdout omits the fenced block", async () => {
    writeJob("demo", "tickScript: .kody/scripts/silent.sh")
    writeScript(".kody/scripts/silent.sh", "#!/usr/bin/env bash\necho 'no fence here'\n")

    const ctx = ctxFor(tmp, "demo")
    await runTickScript(ctx, PROFILE, { jobsDir: ".kody/jobs", slugArg: "job" })

    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.data.nextStateParseError).toMatch(/missing.*kody-job-next-state/)
  })
})
