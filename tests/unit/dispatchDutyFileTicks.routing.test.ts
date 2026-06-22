/**
 * Routing test for `dispatchDutyFileTicks`.
 *
 * Pins the rule that motivated the deterministic-tick path: duties that
 * declare `tickScript` in profile.json run via `duty-tick-scripted`
 * (no agent), everything else uses the configured target. Earlier the
 * dispatcher always invoked the LLM-driven `duty-tick`, which silently
 * dropped state when the model didn't echo the script's stdout.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { dispatchDutyFileTicks } from "../../src/scripts/dispatchDutyFileTicks.js"

vi.mock("../../src/executor.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/executor.js")>("../../src/executor.js")
  return { ...actual, runExecutable: vi.fn(async () => ({ exitCode: 0 })) }
})

import { runExecutable } from "../../src/executor.js"

const runExecutableMock = runExecutable as unknown as Mock

let tmp: string
let storeTmp: string

beforeEach(() => {
  vi.stubEnv("KODY_COMPANY_STORE", "0")
  resetCompanyStoreCacheForTests()
  runExecutableMock.mockReset()
  runExecutableMock.mockResolvedValue({ exitCode: 0 })
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-routing-"))
  storeTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-store-"))
  fs.mkdirSync(path.join(tmp, ".kody", "duties"), { recursive: true })
  fs.mkdirSync(path.join(storeTmp, ".kody", "duties"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(storeTmp, { recursive: true, force: true })
  vi.unstubAllEnvs()
  resetCompanyStoreCacheForTests()
  vi.clearAllMocks()
})

function writeJob(slug: string, profile: Record<string, unknown>, body = "# job\n"): void {
  const dir = path.join(tmp, ".kody", "duties", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "duty.md"), body)
}

function writeStoreJob(slug: string, profile: Record<string, unknown>, body = "# store job\n"): void {
  const dir = path.join(storeTmp, ".kody", "duties", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "duty.md"), body)
}

function ctxFor(configPatch: Partial<KodyConfig> = {}): Context {
  const config: KodyConfig = {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "o", repo: "r" },
    agent: { model: "anthropic/test" },
    jobs: { stateBackend: "local-file" },
    ...configPatch,
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

describe("dispatchDutyFileTicks routing", () => {
  it("does not flat-fan-out when explicit duty is required", async () => {
    writeJob("watch-stale-prs", { every: "6h", agent: "kody" })
    const ctx = ctxFor()

    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
      requireExplicitDuty: true,
    })

    expect(runExecutableMock).not.toHaveBeenCalled()
    expect(ctx.output.reason).toBe("scheduled duty fan-out is owned by goal-scheduler")
  })

  it("routes a duty with `tickScript:` to duty-tick-scripted", async () => {
    writeJob("auto-resolve", { tickScript: ".kody/scripts/auto-resolve-tick.sh", agent: "kody" })

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    expect(runExecutableMock).toHaveBeenCalledTimes(1)
    expect(runExecutableMock.mock.calls[0]![0]).toBe("duty-tick-scripted")
  })

  it("routes a duty without `tickScript:` to the configured (default) target", async () => {
    writeJob("watch-stale-prs", { every: "6h", agent: "kody" })

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    expect(runExecutableMock).toHaveBeenCalledTimes(1)
    expect(runExecutableMock.mock.calls[0]![0]).toBe("duty-tick")
  })

  it("routes duty with executable without passing a synthetic duty arg", async () => {
    writeJob("preview-health", { every: "15m", agent: "cto", executable: "preview-health" })

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    expect(runExecutableMock).toHaveBeenCalledTimes(1)
    expect(runExecutableMock.mock.calls[0]![0]).toBe("preview-health")
    expect(runExecutableMock.mock.calls[0]![1].cliArgs).toEqual({})
  })
  it("skips a duty with no `agent:` (every duty must name an executor)", async () => {
    writeJob("orphan-duty", { every: "1h" })

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    expect(runExecutableMock).not.toHaveBeenCalled()
  })

  it("does not tick store duties unless consumer activates them", async () => {
    vi.stubEnv("KODY_COMPANY_STORE", storeTmp)
    resetCompanyStoreCacheForTests()
    writeStoreJob("store-duty", { every: "1h", agent: "kody" })

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    expect(runExecutableMock).not.toHaveBeenCalled()
  })

  it("ticks store duties activated by the consumer", async () => {
    vi.stubEnv("KODY_COMPANY_STORE", storeTmp)
    resetCompanyStoreCacheForTests()
    writeStoreJob("store-duty", { every: "1h", agent: "kody" })

    const ctx = ctxFor({ company: { activeDuties: ["store-duty"] } })
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    expect(runExecutableMock).toHaveBeenCalledTimes(1)
    expect(runExecutableMock.mock.calls[0]![1].cliArgs).toEqual({ duty: "store-duty" })
  })

  it("mixes routing across slugs in one tick", async () => {
    writeJob("scripted-duty", { tickScript: ".kody/scripts/x.sh", agent: "kody" })
    writeJob("agent-duty", { every: "1h", agent: "kody" })

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    const targets = runExecutableMock.mock.calls.map((call) => call[0])
    expect(targets).toContain("duty-tick-scripted")
    expect(targets).toContain("duty-tick")
  })

  it("can target one duty slug without ticking the other due duties", async () => {
    writeJob("scripted-duty", { tickScript: ".kody/scripts/x.sh", agent: "kody" })
    writeJob("agent-duty", { every: "1h", agent: "kody" })

    const ctx = ctxFor()
    ctx.args = { duty: "agent-duty" }
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    expect(runExecutableMock).toHaveBeenCalledTimes(1)
    expect(runExecutableMock.mock.calls[0]![0]).toBe("duty-tick")
    expect(runExecutableMock.mock.calls[0]![1].cliArgs).toEqual({ duty: "agent-duty" })
  })

  it("ignores a stale legacy .md next to a folder duty", async () => {
    writeJob("hybrid", { every: "1h", agent: "kody" })
    fs.writeFileSync(path.join(tmp, ".kody", "duties", "hybrid.md"), "---\nevery: 1h\nstaff: kody\n---\n# stale\n")

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    const calls = runExecutableMock.mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe("duty-tick")
  })
})
