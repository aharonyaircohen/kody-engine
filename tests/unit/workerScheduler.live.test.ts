/**
 * Live wiring test for the Workers scheduling chain.
 *
 * Loads the REAL `worker-scheduler/profile.json` preflight args (not
 * hardcoded) and drives `dispatchJobFileTicks` against a fixture
 * `.kody/workers/` directory. Proves the change end-to-end at the
 * engine level: the scheduler enumerates worker files, honours the
 * cadence guard, and dispatches `worker-tick` / `worker-tick-scripted`
 * — never the job-* executables.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { dispatchJobFileTicks } from "../../src/scripts/dispatchJobFileTicks.js"

vi.mock("../../src/executor.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/executor.js")>("../../src/executor.js")
  return { ...actual, runExecutable: vi.fn(async () => ({ exitCode: 0 })) }
})

import { runExecutable } from "../../src/executor.js"
const runExecutableMock = runExecutable as unknown as Mock

const SCHEDULER_PROFILE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../src/executables/worker-scheduler/profile.json"),
    "utf-8",
  ),
) as {
  kind: string
  schedule: string
  scripts: { preflight: Array<{ script: string; with: Record<string, string> }> }
}

const PREFLIGHT = SCHEDULER_PROFILE.scripts.preflight[0]!

let tmp: string

beforeEach(() => {
  runExecutableMock.mockReset()
  runExecutableMock.mockResolvedValue({ exitCode: 0 })
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-sched-"))
  fs.mkdirSync(path.join(tmp, ".kody", "workers"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  vi.clearAllMocks()
})

function writeWorker(slug: string, frontmatter: string, body = "# worker\n"): void {
  const fm = frontmatter ? `---\n${frontmatter}\n---\n` : ""
  fs.writeFileSync(path.join(tmp, ".kody", "workers", `${slug}.md`), fm + body)
}

function ctxFor(): Context {
  const config: KodyConfig = {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "o", repo: "r" },
    agent: { model: "anthropic/test" },
    jobs: { stateBackend: "local-file" },
  }
  return { args: {}, cwd: tmp, config, data: {}, output: { exitCode: 0 } }
}

const PROFILE = {} as unknown as Profile

describe("worker-scheduler live wiring", () => {
  it("the profile is a scheduled watch on the same cron as jobs", () => {
    expect(SCHEDULER_PROFILE.kind).toBe("scheduled")
    expect(SCHEDULER_PROFILE.schedule).toBe("*/5 * * * *")
    expect(PREFLIGHT.script).toBe("dispatchJobFileTicks")
    expect(PREFLIGHT.with.jobsDir).toBe(".kody/workers")
    expect(PREFLIGHT.with.targetExecutable).toBe("worker-tick")
    expect(PREFLIGHT.with.scriptedExecutable).toBe("worker-tick-scripted")
  })

  it("ticks an agent worker via worker-tick using the real profile args", async () => {
    writeWorker("daily-digest", "every: 1d")

    const ctx = ctxFor()
    await dispatchJobFileTicks(ctx, PROFILE, PREFLIGHT.with)

    expect(runExecutableMock).toHaveBeenCalledTimes(1)
    expect(runExecutableMock.mock.calls[0]![0]).toBe("worker-tick")
    expect(runExecutableMock.mock.calls[0]![1].cliArgs).toEqual({
      job: "daily-digest",
    })
  })

  it("routes a tickScript worker to worker-tick-scripted (never job-*)", async () => {
    writeWorker("scripted-worker", "tickScript: .kody/scripts/x.sh")
    writeWorker("agent-worker", "every: 1h")

    const ctx = ctxFor()
    await dispatchJobFileTicks(ctx, PROFILE, PREFLIGHT.with)

    const targets = runExecutableMock.mock.calls.map((c) => c[0])
    expect(targets).toContain("worker-tick-scripted")
    expect(targets).toContain("worker-tick")
    expect(targets).not.toContain("job-tick")
    expect(targets).not.toContain("job-tick-scripted")
  })

  it("honours the cadence guard: a manual-only worker never auto-fires", async () => {
    writeWorker("on-demand", "every: manual")

    const ctx = ctxFor()
    await dispatchJobFileTicks(ctx, PROFILE, PREFLIGHT.with)

    expect(runExecutableMock).not.toHaveBeenCalled()
  })

  it("honours the kill switch: a disabled worker is skipped", async () => {
    writeWorker("paused", "every: 1h\ndisabled: true")

    const ctx = ctxFor()
    await dispatchJobFileTicks(ctx, PROFILE, PREFLIGHT.with)

    expect(runExecutableMock).not.toHaveBeenCalled()
  })
})
