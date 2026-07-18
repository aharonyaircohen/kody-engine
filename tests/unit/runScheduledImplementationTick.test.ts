import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/implementations/types.js"
import { runScheduledImplementationTick } from "../../src/scripts/runScheduledImplementationTick.js"
import { buildTickChildEnv } from "../../src/scripts/tickShellRunner.js"

function configFor(): KodyConfig {
  return {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "acme", repo: "widgets" },
    agent: { model: "anthropic/test" },
  }
}

function ctxFor(cwd: string, slug: string): Context {
  return {
    args: { capability: slug },
    cwd,
    config: configFor(),
    data: {},
    output: { exitCode: 0 },
  }
}

function writeTickScript(): void {
  fs.writeFileSync(
    path.join(execDir, "tick.sh"),
    `#!/usr/bin/env bash
cat <<'EOF'
\`\`\`kody-job-next-state
{"cursor":"demo-1","data":{"seen":true},"done":false}
\`\`\`
EOF
`,
  )
}

let tmp: string
let execDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-exec-tick-"))
  execDir = path.join(tmp, ".kody-engine", "definitions", "capabilities", "demo-watch")
  fs.mkdirSync(path.join(tmp, ".kody-engine", "definitions", "capabilities", "demo"), { recursive: true })
  fs.mkdirSync(execDir, { recursive: true })
  fs.writeFileSync(
    path.join(tmp, ".kody-engine", "definitions", "capabilities", "demo", "profile.json"),
    JSON.stringify({ name: "demo", agent: "kody", implementation: "demo-watch" }),
  )
  fs.writeFileSync(path.join(tmp, ".kody-engine", "definitions", "capabilities", "demo", "capability.md"), "# Demo\n")
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe("runScheduledImplementationTick", () => {
  it("forwards generic dry-run flags to implementation-local shell", () => {
    expect(
      buildTickChildEnv(
        {
          PATH: "/bin",
          KODY_DRY_RUN: "1",
          KODY_NO_COMMIT: "1",
          JOB_GAP_SCAN_DRY_RUN: "1",
          SECRET_TOKEN: "nope",
        },
        false,
        {
          path: "capabilities/demo/state.json",
          handle: null,
          state: { version: 1, rev: 3, cursor: "demo", data: { ok: true }, done: false },
          created: false,
        },
      ),
    ).toEqual({
      PATH: "/bin",
      KODY_DRY_RUN: "1",
      KODY_NO_COMMIT: "1",
      KODY_JOB_STATE_JSON: JSON.stringify({ version: 1, rev: 3, cursor: "demo", data: { ok: true }, done: false }),
      KODY_JOB_STATE_PATH: "capabilities/demo/state.json",
    })
  })

  it("runs the implementation-local shell and parses the next-state fence", async () => {
    writeTickScript()

    const ctx = ctxFor(tmp, "demo")
    await runScheduledImplementationTick(ctx, { name: "demo-watch", dir: execDir } as Profile, {
      jobsDir: ".kody-engine/definitions/capabilities",
      slugArg: "capability",
      shell: "tick.sh",
    })

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.data.jobSlug).toBe("demo")
    expect(ctx.data.implementationSlug).toBe("demo-watch")
    expect(ctx.data.nextStateParseError).toBeUndefined()
    expect(ctx.data.nextJobState).toMatchObject({
      cursor: "demo-1",
      data: { seen: true },
      done: false,
    })
  })
})
