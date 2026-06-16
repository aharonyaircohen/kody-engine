import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { runScheduledExecutableTick } from "../../src/scripts/runScheduledExecutableTick.js"

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

let tmp: string
let execDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-exec-tick-"))
  execDir = path.join(tmp, ".kody", "executables", "demo-watch")
  fs.mkdirSync(path.join(tmp, ".kody", "duties", "demo"), { recursive: true })
  fs.mkdirSync(execDir, { recursive: true })
  fs.writeFileSync(
    path.join(tmp, ".kody", "duties", "demo", "profile.json"),
    JSON.stringify({ name: "demo", staff: "kody", executable: "demo-watch" }),
  )
  fs.writeFileSync(path.join(tmp, ".kody", "duties", "demo", "duty.md"), "# Demo\n")
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("runScheduledExecutableTick", () => {
  it("runs the executable-local shell and parses the next-state fence", async () => {
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
})
