/**
 * Routing test for `dispatchJobFileTicks`.
 *
 * Pins the rule that motivated the deterministic-tick path: jobs that
 * declare `tickScript:` in frontmatter run via `job-tick-scripted`
 * (no agent), everything else uses the configured target. Earlier the
 * dispatcher always invoked the LLM-driven `job-tick`, which silently
 * dropped state when the model didn't echo the script's stdout.
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

let tmp: string

beforeEach(() => {
  runExecutableMock.mockReset()
  runExecutableMock.mockResolvedValue({ exitCode: 0 })
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-routing-"))
  fs.mkdirSync(path.join(tmp, ".kody", "jobs"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  vi.clearAllMocks()
})

function writeJob(slug: string, frontmatter: string, body = "# job\n"): void {
  const fm = frontmatter ? `---\n${frontmatter}\n---\n` : ""
  fs.writeFileSync(path.join(tmp, ".kody", "jobs", `${slug}.md`), fm + body)
}

function ctxFor(): Context {
  const config: KodyConfig = {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "o", repo: "r" },
    agent: { model: "anthropic/test" },
    jobs: { stateBackend: "local-file" },
  }
  return {
    args: {},
    cwd: tmp,
    config,
    data: {},
    output: { exitCode: 0 },
  }
}

const PROFILE = {} as unknown as Profile

describe("dispatchJobFileTicks routing", () => {
  it("routes a job with `tickScript:` to job-tick-scripted", async () => {
    writeJob("auto-resolve", "tickScript: .kody/scripts/auto-resolve-tick.sh\nworker: kody")

    const ctx = ctxFor()
    await dispatchJobFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/jobs",
      targetExecutable: "job-tick",
      slugArg: "job",
    })

    expect(runExecutableMock).toHaveBeenCalledTimes(1)
    expect(runExecutableMock.mock.calls[0]![0]).toBe("job-tick-scripted")
  })

  it("routes a job without `tickScript:` to the configured (default) target", async () => {
    writeJob("watch-stale-prs", "every: 6h\nworker: kody")

    const ctx = ctxFor()
    await dispatchJobFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/jobs",
      targetExecutable: "job-tick",
      slugArg: "job",
    })

    expect(runExecutableMock).toHaveBeenCalledTimes(1)
    expect(runExecutableMock.mock.calls[0]![0]).toBe("job-tick")
  })

  it("skips a job with no `worker:` (every job must name an executor)", async () => {
    writeJob("orphan-job", "every: 1h")

    const ctx = ctxFor()
    await dispatchJobFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/jobs",
      targetExecutable: "job-tick",
      slugArg: "job",
    })

    expect(runExecutableMock).not.toHaveBeenCalled()
  })

  it("mixes routing across slugs in one tick", async () => {
    writeJob("scripted-job", "tickScript: .kody/scripts/x.sh\nworker: kody")
    writeJob("agent-job", "every: 1h\nworker: kody")

    const ctx = ctxFor()
    await dispatchJobFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/jobs",
      targetExecutable: "job-tick",
      slugArg: "job",
    })

    const targets = runExecutableMock.mock.calls.map((call) => call[0])
    expect(targets).toContain("job-tick-scripted")
    expect(targets).toContain("job-tick")
  })
})
