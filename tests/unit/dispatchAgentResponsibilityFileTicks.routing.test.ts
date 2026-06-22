/**
 * Routing test for `dispatchAgentResponsibilityFileTicks`.
 *
 * Pins the rule that motivated the deterministic-tick path: agentResponsibilities that
 * declare `tickScript` in profile.json run via `agent-responsibility-tick-scripted`
 * (no agent), everything else uses the configured target. Earlier the
 * dispatcher always invoked the LLM-driven `agent-responsibility-tick`, which silently
 * dropped state when the model didn't echo the script's stdout.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import type { Context, Profile } from "../../src/agent-actions/types.js"
import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import type { KodyConfig } from "../../src/config.js"
import { dispatchAgentResponsibilityFileTicks } from "../../src/scripts/dispatchAgentResponsibilityFileTicks.js"

vi.mock("../../src/executor.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/executor.js")>("../../src/executor.js")
  return { ...actual, runAgentAction: vi.fn(async () => ({ exitCode: 0 })) }
})

import { runAgentAction } from "../../src/executor.js"

const runAgentActionMock = runAgentAction as unknown as Mock

let tmp: string
let storeTmp: string

beforeEach(() => {
  vi.stubEnv("KODY_COMPANY_STORE", "0")
  resetCompanyStoreCacheForTests()
  runAgentActionMock.mockReset()
  runAgentActionMock.mockResolvedValue({ exitCode: 0 })
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-routing-"))
  storeTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-store-"))
  fs.mkdirSync(path.join(tmp, ".kody", "agent-responsibilities"), { recursive: true })
  fs.mkdirSync(path.join(storeTmp, ".kody", "agent-responsibilities"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(storeTmp, { recursive: true, force: true })
  vi.unstubAllEnvs()
  resetCompanyStoreCacheForTests()
  vi.clearAllMocks()
})

function writeJob(slug: string, profile: Record<string, unknown>, body = "# job\n"): void {
  const dir = path.join(tmp, ".kody", "agent-responsibilities", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "agent-responsibility.md"), body)
}

function writeStoreJob(slug: string, profile: Record<string, unknown>, body = "# store job\n"): void {
  const dir = path.join(storeTmp, ".kody", "agent-responsibilities", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "agent-responsibility.md"), body)
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

describe("dispatchAgentResponsibilityFileTicks routing", () => {
  it("does not flat-fan-out when explicit agentResponsibility is required", async () => {
    writeJob("watch-stale-prs", { every: "6h", agent: "kody" })
    const ctx = ctxFor()

    await dispatchAgentResponsibilityFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/agent-responsibilities",
      targetAgentAction: "agent-responsibility-tick",
      slugArg: "agentResponsibility",
      requireExplicitAgentResponsibility: true,
    })

    expect(runAgentActionMock).not.toHaveBeenCalled()
    expect(ctx.output.reason).toBe("scheduled agentResponsibility fan-out is owned by goal-scheduler")
  })

  it("routes a agentResponsibility with `tickScript:` to agent-responsibility-tick-scripted", async () => {
    writeJob("auto-resolve", { tickScript: ".kody/scripts/auto-resolve-tick.sh", agent: "kody" })

    const ctx = ctxFor()
    await dispatchAgentResponsibilityFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/agent-responsibilities",
      targetAgentAction: "agent-responsibility-tick",
      slugArg: "agentResponsibility",
    })

    expect(runAgentActionMock).toHaveBeenCalledTimes(1)
    expect(runAgentActionMock.mock.calls[0]![0]).toBe("agent-responsibility-tick-scripted")
  })

  it("routes a agentResponsibility without `tickScript:` to the configured (default) target", async () => {
    writeJob("watch-stale-prs", { every: "6h", agent: "kody" })

    const ctx = ctxFor()
    await dispatchAgentResponsibilityFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/agent-responsibilities",
      targetAgentAction: "agent-responsibility-tick",
      slugArg: "agentResponsibility",
    })

    expect(runAgentActionMock).toHaveBeenCalledTimes(1)
    expect(runAgentActionMock.mock.calls[0]![0]).toBe("agent-responsibility-tick")
  })

  it("routes agentResponsibility with agentAction without passing a synthetic agentResponsibility arg", async () => {
    writeJob("preview-health", { every: "15m", agent: "cto", agentAction: "preview-health" })

    const ctx = ctxFor()
    await dispatchAgentResponsibilityFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/agent-responsibilities",
      targetAgentAction: "agent-responsibility-tick",
      slugArg: "agentResponsibility",
    })

    expect(runAgentActionMock).toHaveBeenCalledTimes(1)
    expect(runAgentActionMock.mock.calls[0]![0]).toBe("preview-health")
    expect(runAgentActionMock.mock.calls[0]![1].cliArgs).toEqual({})
  })
  it("skips a agentResponsibility with no `agent:` (every agentResponsibility must name an executor)", async () => {
    writeJob("orphan-agent-responsibility", { every: "1h" })

    const ctx = ctxFor()
    await dispatchAgentResponsibilityFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/agent-responsibilities",
      targetAgentAction: "agent-responsibility-tick",
      slugArg: "agentResponsibility",
    })

    expect(runAgentActionMock).not.toHaveBeenCalled()
  })

  it("does not tick store agentResponsibilities unless consumer activates them", async () => {
    vi.stubEnv("KODY_COMPANY_STORE", storeTmp)
    resetCompanyStoreCacheForTests()
    writeStoreJob("store-agent-responsibility", { every: "1h", agent: "kody" })

    const ctx = ctxFor()
    await dispatchAgentResponsibilityFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/agent-responsibilities",
      targetAgentAction: "agent-responsibility-tick",
      slugArg: "agentResponsibility",
    })

    expect(runAgentActionMock).not.toHaveBeenCalled()
  })

  it("ticks store agentResponsibilities activated by the consumer", async () => {
    vi.stubEnv("KODY_COMPANY_STORE", storeTmp)
    resetCompanyStoreCacheForTests()
    writeStoreJob("store-agent-responsibility", { every: "1h", agent: "kody" })

    const ctx = ctxFor({ company: { activeAgentResponsibilities: ["store-agent-responsibility"] } })
    await dispatchAgentResponsibilityFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/agent-responsibilities",
      targetAgentAction: "agent-responsibility-tick",
      slugArg: "agentResponsibility",
    })

    expect(runAgentActionMock).toHaveBeenCalledTimes(1)
    expect(runAgentActionMock.mock.calls[0]![1].cliArgs).toEqual({ agentResponsibility: "store-agent-responsibility" })
  })

  it("mixes routing across slugs in one tick", async () => {
    writeJob("scripted-agent-responsibility", { tickScript: ".kody/scripts/x.sh", agent: "kody" })
    writeJob("agent-agent-responsibility", { every: "1h", agent: "kody" })

    const ctx = ctxFor()
    await dispatchAgentResponsibilityFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/agent-responsibilities",
      targetAgentAction: "agent-responsibility-tick",
      slugArg: "agentResponsibility",
    })

    const targets = runAgentActionMock.mock.calls.map((call) => call[0])
    expect(targets).toContain("agent-responsibility-tick-scripted")
    expect(targets).toContain("agent-responsibility-tick")
  })

  it("can target one agentResponsibility slug without ticking the other due agentResponsibilities", async () => {
    writeJob("scripted-agent-responsibility", { tickScript: ".kody/scripts/x.sh", agent: "kody" })
    writeJob("agent-agent-responsibility", { every: "1h", agent: "kody" })

    const ctx = ctxFor()
    ctx.args = { agentResponsibility: "agent-agent-responsibility" }
    await dispatchAgentResponsibilityFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/agent-responsibilities",
      targetAgentAction: "agent-responsibility-tick",
      slugArg: "agentResponsibility",
    })

    expect(runAgentActionMock).toHaveBeenCalledTimes(1)
    expect(runAgentActionMock.mock.calls[0]![0]).toBe("agent-responsibility-tick")
    expect(runAgentActionMock.mock.calls[0]![1].cliArgs).toEqual({ agentResponsibility: "agent-agent-responsibility" })
  })

  it("ignores a stale legacy .md next to a folder agentResponsibility", async () => {
    writeJob("hybrid", { every: "1h", agent: "kody" })
    fs.writeFileSync(
      path.join(tmp, ".kody", "agent-responsibilities", "hybrid.md"),
      "---\nevery: 1h\nagent: kody\n---\n# stale\n",
    )

    const ctx = ctxFor()
    await dispatchAgentResponsibilityFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/agent-responsibilities",
      targetAgentAction: "agent-responsibility-tick",
      slugArg: "agentResponsibility",
    })

    const calls = runAgentActionMock.mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe("agent-responsibility-tick")
  })
})
