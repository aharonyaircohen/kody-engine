/**
 * Unit tests for PoolRegistry — the per-repo warm-pool registry.
 *
 * PoolRegistry's only collaborators are FlyClient (constructed), PoolManager
 * (constructed + driven), and the vault reads (readRepoSecret / readRepoSecrets).
 * We mock all three so the tests stay pure: FlyClient becomes a no-op ctor,
 * PoolManager becomes a fake with spy methods, and the vault funcs are spies we
 * point at per-test values. This lets us exercise the registry's own logic
 * (lazy per-repo pool creation, the default resolveFlyToken / resolvePoolMin
 * closures + their parsePoolMin clamping, claim's secret filtering + setMin,
 * status / resyncAll / activeRepos, and every error/fallback branch) without
 * touching Fly, GitHub, or crypto.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readRepoSecret: vi.fn(),
  readRepoSecrets: vi.fn(),
  PoolManagerCtor: vi.fn(),
  FlyClientCtor: vi.fn(),
}))

// Fake PoolManager instance factory — each repo gets its own with spy methods.
function makeFakePm() {
  return {
    setMin: vi.fn(),
    reconcile: vi.fn(async () => {}),
    resync: vi.fn(async () => {}),
    claim: vi.fn(async () => ({ ok: true, machineId: "m-1" })),
    status: vi.fn(() => ({ min: 1, free: 1, booting: 0, claimsInFlight: 0, total: 2 })),
  }
}

// Mock the constructors as plain functions. `new fn(args)` where `fn` returns an
// object yields that object — so each `new PoolManager(deps)` becomes whatever
// fake mocks.PoolManagerCtor produces, which the tests hold a reference to.
// (Using functions, not classes, sidesteps biome's noConstructorReturn.)
vi.mock("../../src/pool/fly.js", () => ({
  FlyClient: function FlyClient(opts: unknown) {
    mocks.FlyClientCtor(opts)
  },
}))

vi.mock("../../src/pool/manager.js", () => ({
  PoolManager: function PoolManager(deps: unknown) {
    return mocks.PoolManagerCtor(deps)
  },
}))

vi.mock("../../src/pool/vault.js", () => ({
  readRepoSecret: mocks.readRepoSecret,
  readRepoSecrets: mocks.readRepoSecrets,
}))

import { type ClaimRequest, PoolRegistry, type RegistryConfig } from "../../src/pool/registry.js"

function baseConfig(overrides: Partial<RegistryConfig> = {}): RegistryConfig {
  return {
    githubToken: "ghtok",
    masterKey: Buffer.alloc(32, 7),
    base: {
      min: 2,
      image: "img",
      region: "iad",
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
      runnerApiKey: "rk",
      port: 8080,
      healthTimeoutMs: 1000,
      app: "kody-app",
    },
    ...overrides,
  }
}

function makeReq(over: Partial<ClaimRequest> = {}): ClaimRequest {
  return { jobId: "job-1", repo: "o/r", ...over }
}

beforeEach(() => {
  mocks.readRepoSecret.mockReset()
  mocks.readRepoSecrets.mockReset()
  mocks.PoolManagerCtor.mockReset()
  mocks.FlyClientCtor.mockReset()
  // Default: every constructed PoolManager is a fresh fake.
  mocks.PoolManagerCtor.mockImplementation(() => makeFakePm())
})

describe("PoolRegistry.claim — happy path with injected resolvers", () => {
  it("creates a pool, filters reserved keys from secrets, and returns the PoolManager result", async () => {
    const pm = makeFakePm()
    mocks.PoolManagerCtor.mockImplementationOnce(() => pm)
    mocks.readRepoSecrets.mockResolvedValueOnce({
      FLY_API_TOKEN: "fly-secret",
      POOL_MIN: "5",
      ANTHROPIC_API_KEY: "sk-1",
      OPENAI_API_KEY: "sk-2",
    })
    const reg = new PoolRegistry(
      baseConfig({
        resolveFlyToken: vi.fn(async () => "fly-token"),
        resolvePoolMin: vi.fn(async () => 3),
      }),
    )

    const res = await reg.claim("Owner", "Repo", makeReq({ issueNumber: 9 }))

    expect(res).toEqual({ ok: true, machineId: "m-1" })
    // FlyClient constructed with the resolved token + base app.
    expect(mocks.FlyClientCtor).toHaveBeenCalledWith({ token: "fly-token", app: "kody-app" })
    // PoolManager constructed once, with repoTag lowercased + resolved min.
    const deps = mocks.PoolManagerCtor.mock.calls[0]?.[0] as { config: { repoTag: string; min: number } }
    expect(deps.config.repoTag).toBe("owner/repo")
    expect(deps.config.min).toBe(3)
    // reconcile kicked off on first creation.
    expect(pm.reconcile).toHaveBeenCalledTimes(1)
    // setMin applied from latest vault POOL_MIN (5).
    expect(pm.setMin).toHaveBeenCalledWith(5)
    // Job's allSecrets excludes FLY_API_TOKEN and POOL_MIN.
    const job = (pm.claim.mock.calls[0] as unknown[])?.[0] as {
      allSecrets: Record<string, string>
      repo: string
      mode: string
    }
    expect(job.allSecrets).toEqual({ ANTHROPIC_API_KEY: "sk-1", OPENAI_API_KEY: "sk-2" })
    expect(job.repo).toBe("Owner/Repo")
    expect(job.mode).toBe("issue")
  })

  it("forwards all request fields onto the PoolJob, defaulting mode to issue", async () => {
    const pm = makeFakePm()
    mocks.PoolManagerCtor.mockImplementationOnce(() => pm)
    mocks.readRepoSecrets.mockResolvedValueOnce({})
    const reg = new PoolRegistry(baseConfig({ resolveFlyToken: vi.fn(async () => "t") }))

    await reg.claim("o", "r", {
      jobId: "j2",
      repo: "o/r",
      mode: "interactive",
      sessionId: "sess-1",
      idleExitMs: 1000,
      hardCapMs: 2000,
      ref: "main",
      model: "anthropic/x",
      dashboardUrl: "https://dash",
    })

    const job = (pm.claim.mock.calls[0] as unknown[])?.[0] as Record<string, unknown>
    expect(job).toMatchObject({
      jobId: "j2",
      mode: "interactive",
      sessionId: "sess-1",
      idleExitMs: 1000,
      hardCapMs: 2000,
      ref: "main",
      model: "anthropic/x",
      dashboardUrl: "https://dash",
      githubToken: "ghtok",
    })
  })

  it("reuses the same PoolManager for a second claim on the same repo (case-insensitive key)", async () => {
    mocks.readRepoSecrets.mockResolvedValue({})
    const reg = new PoolRegistry(baseConfig({ resolveFlyToken: vi.fn(async () => "t") }))

    await reg.claim("o", "r", makeReq())
    await reg.claim("O", "R", makeReq({ jobId: "job-2" }))

    expect(mocks.PoolManagerCtor).toHaveBeenCalledTimes(1)
    expect(reg.activeRepos()).toEqual(["o/r"])
  })
})

describe("PoolRegistry.claim — no-pool / error branches", () => {
  it("returns ok:false when the repo has no Fly token", async () => {
    const logs: string[] = []
    const reg = new PoolRegistry(baseConfig({ resolveFlyToken: vi.fn(async () => null), log: (m) => logs.push(m) }))

    const res = await reg.claim("o", "r", makeReq())

    expect(res).toEqual({ ok: false, reason: "repo has no FLY_API_TOKEN (no pool)" })
    expect(mocks.PoolManagerCtor).not.toHaveBeenCalled()
    expect(logs.some((l) => l.includes("no FLY_API_TOKEN"))).toBe(true)
  })

  it("returns ok:false and logs when the Fly-token resolve throws", async () => {
    const logs: string[] = []
    const reg = new PoolRegistry(
      baseConfig({
        resolveFlyToken: vi.fn(async () => {
          throw new Error("vault boom")
        }),
        log: (m) => logs.push(m),
      }),
    )

    const res = await reg.claim("o", "r", makeReq())

    expect(res.ok).toBe(false)
    expect(logs.some((l) => l.includes("vault read failed") && l.includes("vault boom"))).toBe(true)
  })

  it("falls back to base.min when resolvePoolMin throws, and still creates the pool", async () => {
    const logs: string[] = []
    const pm = makeFakePm()
    mocks.PoolManagerCtor.mockImplementationOnce(() => pm)
    mocks.readRepoSecrets.mockResolvedValueOnce({})
    const reg = new PoolRegistry(
      baseConfig({
        resolveFlyToken: vi.fn(async () => "t"),
        resolvePoolMin: vi.fn(async () => {
          throw new Error("min boom")
        }),
        log: (m) => logs.push(m),
      }),
    )

    const res = await reg.claim("o", "r", makeReq())

    expect(res.ok).toBe(true)
    const deps = mocks.PoolManagerCtor.mock.calls[0]?.[0] as { config: { min: number } }
    expect(deps.config.min).toBe(2) // base.min
    expect(logs.some((l) => l.includes("pool-min read failed"))).toBe(true)
  })

  it("logs and proceeds with empty secrets when readRepoSecrets throws", async () => {
    const logs: string[] = []
    const pm = makeFakePm()
    mocks.PoolManagerCtor.mockImplementationOnce(() => pm)
    mocks.readRepoSecrets.mockRejectedValueOnce(new Error("secrets boom"))
    const reg = new PoolRegistry(baseConfig({ resolveFlyToken: vi.fn(async () => "t"), log: (m) => logs.push(m) }))

    const res = await reg.claim("o", "r", makeReq())

    expect(res.ok).toBe(true)
    const job = (pm.claim.mock.calls[0] as unknown[])?.[0] as { allSecrets: Record<string, string> }
    expect(job.allSecrets).toEqual({})
    expect(logs.some((l) => l.includes("vault secrets read failed"))).toBe(true)
  })

  it("logs reconcile failure without rejecting the claim", async () => {
    const logs: string[] = []
    const pm = makeFakePm()
    pm.reconcile.mockRejectedValueOnce(new Error("reconcile boom"))
    mocks.PoolManagerCtor.mockImplementationOnce(() => pm)
    mocks.readRepoSecrets.mockResolvedValueOnce({})
    const reg = new PoolRegistry(baseConfig({ resolveFlyToken: vi.fn(async () => "t"), log: (m) => logs.push(m) }))

    const res = await reg.claim("o", "r", makeReq())
    // Let the floating reconcile().catch settle.
    await Promise.resolve()
    await Promise.resolve()

    expect(res.ok).toBe(true)
    expect(logs.some((l) => l.includes("reconcile") && l.includes("reconcile boom"))).toBe(true)
  })
})

describe("PoolRegistry default resolvers (vault-backed closures)", () => {
  it("resolveFlyToken default reads FLY_API_TOKEN from the vault", async () => {
    mocks.readRepoSecret.mockResolvedValueOnce("vault-fly-token") // FLY_API_TOKEN
    mocks.readRepoSecret.mockResolvedValueOnce("4") // POOL_MIN
    mocks.readRepoSecrets.mockResolvedValueOnce({})
    const reg = new PoolRegistry(baseConfig()) // no injected resolvers

    const res = await reg.claim("o", "r", makeReq())

    expect(res.ok).toBe(true)
    expect(mocks.readRepoSecret).toHaveBeenCalledWith(
      expect.objectContaining({ githubToken: "ghtok", owner: "o", repo: "r", name: "FLY_API_TOKEN" }),
    )
    expect(mocks.readRepoSecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: "POOL_MIN", owner: "o", repo: "r" }),
    )
    // POOL_MIN "4" parsed → 4 applied as min.
    const deps = mocks.PoolManagerCtor.mock.calls[0]?.[0] as { config: { min: number } }
    expect(deps.config.min).toBe(4)
  })

  it("default resolvePoolMin clamps an over-cap POOL_MIN to the ceiling (10)", async () => {
    mocks.readRepoSecret.mockResolvedValueOnce("token") // FLY_API_TOKEN
    mocks.readRepoSecret.mockResolvedValueOnce("999") // POOL_MIN (over cap)
    mocks.readRepoSecrets.mockResolvedValueOnce({})
    const reg = new PoolRegistry(baseConfig())

    await reg.claim("o", "r", makeReq())

    const deps = mocks.PoolManagerCtor.mock.calls[0]?.[0] as { config: { min: number } }
    expect(deps.config.min).toBe(10)
  })

  it("default resolvePoolMin falls back to base.min on blank/garbage POOL_MIN", async () => {
    mocks.readRepoSecret.mockResolvedValueOnce("token") // FLY_API_TOKEN
    mocks.readRepoSecret.mockResolvedValueOnce("  ") // POOL_MIN blank
    mocks.readRepoSecrets.mockResolvedValueOnce({})
    const reg = new PoolRegistry(baseConfig())

    await reg.claim("o", "r", makeReq())

    const deps = mocks.PoolManagerCtor.mock.calls[0]?.[0] as { config: { min: number } }
    expect(deps.config.min).toBe(2) // base.min
  })

  it("default resolvePoolMin falls back to base.min on a negative / non-integer POOL_MIN", async () => {
    mocks.readRepoSecret.mockResolvedValueOnce("token")
    mocks.readRepoSecret.mockResolvedValueOnce("-3")
    mocks.readRepoSecrets.mockResolvedValueOnce({})
    const reg = new PoolRegistry(baseConfig())

    await reg.claim("o", "r", makeReq())

    const deps = mocks.PoolManagerCtor.mock.calls[0]?.[0] as { config: { min: number } }
    expect(deps.config.min).toBe(2)
  })
})

describe("PoolRegistry.status", () => {
  it("returns null for a repo with no pool yet", () => {
    const reg = new PoolRegistry(baseConfig())
    expect(reg.status("o", "r")).toBeNull()
  })

  it("returns the PoolManager status once a pool exists", async () => {
    const pm = makeFakePm()
    mocks.PoolManagerCtor.mockImplementationOnce(() => pm)
    mocks.readRepoSecrets.mockResolvedValueOnce({})
    const reg = new PoolRegistry(baseConfig({ resolveFlyToken: vi.fn(async () => "t") }))

    await reg.claim("o", "r", makeReq())

    expect(reg.status("O", "R")).toEqual({ min: 1, free: 1, booting: 0, claimsInFlight: 0, total: 2 })
    expect(pm.status).toHaveBeenCalled()
  })

  it("statusFor lazily creates the repo pool and returns its status", async () => {
    const pm = makeFakePm()
    mocks.PoolManagerCtor.mockImplementationOnce(() => pm)
    mocks.readRepoSecret.mockResolvedValueOnce("fly-token")
    mocks.readRepoSecret.mockResolvedValueOnce("2")
    const reg = new PoolRegistry(baseConfig())

    await expect(reg.statusFor("o", "r")).resolves.toEqual({
      min: 1,
      free: 1,
      booting: 0,
      claimsInFlight: 0,
      total: 2,
    })
    expect(mocks.PoolManagerCtor).toHaveBeenCalledTimes(1)
    expect(pm.reconcile).toHaveBeenCalledTimes(1)
  })
})

describe("PoolRegistry.resyncAll", () => {
  it("re-reads pool-min and resyncs every active pool", async () => {
    const pm = makeFakePm()
    mocks.PoolManagerCtor.mockImplementationOnce(() => pm)
    mocks.readRepoSecrets.mockResolvedValueOnce({})
    const resolvePoolMin = vi.fn(async () => 6)
    const reg = new PoolRegistry(baseConfig({ resolveFlyToken: vi.fn(async () => "t"), resolvePoolMin }))
    await reg.claim("o", "r", makeReq())

    await reg.resyncAll()

    // setMin called with the refreshed value (last call), resync invoked.
    expect(pm.setMin).toHaveBeenLastCalledWith(6)
    expect(pm.resync).toHaveBeenCalledTimes(1)
    // resolvePoolMin called with the split owner/repo from the tag.
    expect(resolvePoolMin).toHaveBeenLastCalledWith("o", "r")
  })

  it("logs and continues when pool-min refresh throws, still calling resync", async () => {
    const logs: string[] = []
    const pm = makeFakePm()
    mocks.PoolManagerCtor.mockImplementationOnce(() => pm)
    mocks.readRepoSecrets.mockResolvedValueOnce({})
    let calls = 0
    const reg = new PoolRegistry(
      baseConfig({
        resolveFlyToken: vi.fn(async () => "t"),
        resolvePoolMin: vi.fn(async () => {
          calls++
          if (calls >= 2) throw new Error("refresh boom")
          return 2
        }),
        log: (m) => logs.push(m),
      }),
    )
    await reg.claim("o", "r", makeReq())

    await reg.resyncAll()

    expect(logs.some((l) => l.includes("pool-min refresh"))).toBe(true)
    expect(pm.resync).toHaveBeenCalledTimes(1)
  })

  it("logs when a pool's resync rejects", async () => {
    const logs: string[] = []
    const pm = makeFakePm()
    pm.resync.mockRejectedValueOnce(new Error("resync boom"))
    mocks.PoolManagerCtor.mockImplementationOnce(() => pm)
    mocks.readRepoSecrets.mockResolvedValueOnce({})
    const reg = new PoolRegistry(
      baseConfig({
        resolveFlyToken: vi.fn(async () => "t"),
        resolvePoolMin: vi.fn(async () => 2),
        log: (m) => logs.push(m),
      }),
    )
    await reg.claim("o", "r", makeReq())

    await reg.resyncAll()

    expect(logs.some((l) => l.includes("resync") && l.includes("resync boom"))).toBe(true)
  })

  it("is a no-op with no active pools", async () => {
    const reg = new PoolRegistry(baseConfig())
    await expect(reg.resyncAll()).resolves.toBeUndefined()
  })
})

describe("PoolRegistry — log plumbing", () => {
  it("uses a silent default log when none is supplied (no-token claim)", async () => {
    // No `log` in config → the registry's default no-op closure runs.
    const reg = new PoolRegistry(baseConfig({ resolveFlyToken: vi.fn(async () => null) }))
    const res = await reg.claim("o", "r", makeReq())
    expect(res.ok).toBe(false)
  })

  it("prefixes per-pool log lines with the repo tag", async () => {
    const logs: string[] = []
    const pm = makeFakePm()
    mocks.PoolManagerCtor.mockImplementationOnce(() => pm)
    mocks.readRepoSecrets.mockResolvedValueOnce({})
    const reg = new PoolRegistry(baseConfig({ resolveFlyToken: vi.fn(async () => "t"), log: (m) => logs.push(m) }))
    await reg.claim("Acme", "Web", makeReq())

    // PoolManager is mocked, so invoke the log closure it was handed directly.
    const deps = mocks.PoolManagerCtor.mock.calls[0]?.[0] as { log: (m: string) => void }
    deps.log("hello")
    expect(logs).toContain("[acme/web] hello")
  })
})

describe("PoolRegistry.activeRepos", () => {
  it("starts empty and lists each repo tag after a successful claim", async () => {
    mocks.readRepoSecrets.mockResolvedValue({})
    const reg = new PoolRegistry(baseConfig({ resolveFlyToken: vi.fn(async () => "t") }))

    expect(reg.activeRepos()).toEqual([])

    await reg.claim("Acme", "Web", makeReq())
    await reg.claim("Acme", "Api", makeReq({ jobId: "j2", repo: "Acme/Api" }))

    expect(reg.activeRepos().sort()).toEqual(["acme/api", "acme/web"])
  })
})
