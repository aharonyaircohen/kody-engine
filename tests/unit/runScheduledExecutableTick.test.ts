import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { KodyConfig } from "../../src/config.js"
import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { runScheduledExecutableTick } from "../../src/scripts/runScheduledExecutableTick.js"
import { buildTickChildEnv } from "../../src/scripts/tickShellRunner.js"

function configFor(): KodyConfig {
  return {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "acme", repo: "widgets" },
    agent: { model: "anthropic/test" },
    jobs: { stateBackend: "local-file" },
  }
}

function ctxFor(cwd: string, slug: string): Context {
  return {
    args: { duty: slug },
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
  execDir = path.join(tmp, ".kody", "executables", "demo-watch")
  fs.mkdirSync(path.join(tmp, ".kody", "duties", "demo"), { recursive: true })
  fs.mkdirSync(execDir, { recursive: true })
  fs.writeFileSync(
    path.join(tmp, ".kody", "duties", "demo", "profile.json"),
    JSON.stringify({ name: "demo", agent: "kody", executable: "demo-watch" }),
  )
  fs.writeFileSync(path.join(tmp, ".kody", "duties", "demo", "duty.md"), "# Demo\n")
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  vi.unstubAllEnvs()
  resetCompanyStoreCacheForTests()
})

describe("runScheduledExecutableTick", () => {
  it("forwards generic dry-run flags to executable-local shell", () => {
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
      ),
    ).toEqual({
      PATH: "/bin",
      KODY_DRY_RUN: "1",
      KODY_NO_COMMIT: "1",
    })
  })

  it("runs the executable-local shell and parses the next-state fence", async () => {
    writeTickScript()

    const ctx = ctxFor(tmp, "demo")
    await runScheduledExecutableTick(ctx, { name: "demo-watch", dir: execDir } as Profile, {
      jobsDir: ".kody/duties",
      slugArg: "duty",
      shell: "tick.sh",
    })

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.data.jobSlug).toBe("demo")
    expect(ctx.data.executableSlug).toBe("demo-watch")
    expect(ctx.data.nextStateParseError).toBeUndefined()
    expect(ctx.data.nextJobState).toMatchObject({
      cursor: "demo-1",
      data: { seen: true },
      done: false,
    })
  })

  it("loads duty metadata from company store when project duty folder is absent", async () => {
    writeTickScript()
    fs.rmSync(path.join(tmp, ".kody", "duties", "demo"), { recursive: true, force: true })
    const storeRoot = path.join(tmp, "store")
    const storeDutyDir = path.join(storeRoot, ".kody", "duties", "demo")
    fs.mkdirSync(storeDutyDir, { recursive: true })
    fs.writeFileSync(
      path.join(storeDutyDir, "profile.json"),
      JSON.stringify({
        name: "demo",
        every: "15m",
        agent: "kody",
        executable: "demo-watch",
      }),
    )
    fs.writeFileSync(path.join(storeDutyDir, "duty.md"), "# Store Demo\n")
    vi.stubEnv("KODY_COMPANY_STORE", storeRoot)
    resetCompanyStoreCacheForTests()

    const ctx = ctxFor(tmp, "demo")
    await runScheduledExecutableTick(ctx, { name: "demo-watch", dir: execDir } as Profile, {
      jobsDir: ".kody/duties",
      slugArg: "duty",
      shell: "tick.sh",
    })

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBe(0)
    expect(ctx.data.jobSlug).toBe("demo")
    expect(ctx.data.nextJobState).toMatchObject({
      cursor: "demo-1",
      data: { seen: true },
      done: false,
    })
  })
})
