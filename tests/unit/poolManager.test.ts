import { describe, expect, it } from "vitest"

import type { FlyClient, FlyMachine } from "../../src/pool/fly.js"
import { PoolManager, type PoolConfig, type PoolJob } from "../../src/pool/manager.js"

const CONFIG: PoolConfig = {
  min: 2,
  image: "registry.fly.io/kody-runner:latest",
  region: "fra",
  guest: { cpu_kind: "performance", cpus: 1, memory_mb: 2048 },
  runnerApiKey: "runner-key",
  litellmUrl: "http://kody-litellm.internal:4000",
  port: 8080,
  healthTimeoutMs: 5_000,
}

const JOB: PoolJob = { jobId: "j1", repo: "o/r", issueNumber: 3, githubToken: "ghp_x" }

/** Wait until `cond()` holds or the budget elapses — the post-claim refill is
 * detached (fire-and-forget), so tests poll for it to settle. */
async function waitFor(cond: () => boolean, budgetMs = 1_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** A fake FlyClient that hands out sequential machine ids and tracks calls. */
function makeFly(over: Partial<Record<keyof FlyClient, unknown>> = {}) {
  let seq = 0
  const created: string[] = []
  const destroyed: string[] = []
  const started: string[] = []
  const suspended: string[] = []
  const fly = {
    createPooled: async (): Promise<FlyMachine> => {
      seq++
      const id = `m${seq}`
      created.push(id)
      return { id, private_ip: `fdaa::${seq}`, state: "created" }
    },
    get: async (id: string): Promise<FlyMachine | null> => ({ id, private_ip: `fdaa::x`, state: "created" }),
    listPooled: async (): Promise<FlyMachine[]> => [],
    suspend: async (id: string) => {
      suspended.push(id)
    },
    start: async (id: string) => {
      started.push(id)
    },
    destroy: async (id: string) => {
      destroyed.push(id)
    },
    waitHealthy: async (): Promise<boolean> => true,
    ...over,
  } as unknown as FlyClient
  return { fly, created, destroyed, started, suspended }
}

describe("PoolManager.refill", () => {
  it("boots machines up to min and marks them free", async () => {
    const { fly, created, suspended } = makeFly()
    const pm = new PoolManager({ fly, config: CONFIG, postRun: async () => true })
    await pm.refill()
    expect(pm.status().free).toBe(2)
    expect(created).toHaveLength(2)
    expect(suspended).toEqual(created) // each booted machine is frozen
  })

  it("does not overshoot min on repeated calls", async () => {
    const { fly, created } = makeFly()
    const pm = new PoolManager({ fly, config: CONFIG, postRun: async () => true })
    await pm.refill()
    await pm.refill()
    expect(created).toHaveLength(2)
    expect(pm.status().free).toBe(2)
  })

  it("destroys a machine that never becomes healthy", async () => {
    const { fly, destroyed } = makeFly({ waitHealthy: async () => false })
    const pm = new PoolManager({ fly, config: CONFIG, postRun: async () => true })
    await pm.refill()
    expect(pm.status().free).toBe(0)
    expect(destroyed.length).toBeGreaterThan(0)
  })
})

describe("PoolManager.claim", () => {
  it("hands out a free machine, runs the job, and refills back to min", async () => {
    const { fly, started, created } = makeFly()
    const pm = new PoolManager({ fly, config: CONFIG, postRun: async () => true })
    await pm.refill()
    expect(pm.status().free).toBe(2)

    const res = await pm.claim(JOB)
    expect(res.ok).toBe(true)
    expect(res.machineId).toBeTruthy()
    expect(started).toContain(res.machineId) // claimed machine was woken
    // refill is detached — wait for it to restore the pool back to min.
    await waitFor(() => pm.status().free === 2)
    expect(created).toHaveLength(3) // 2 initial + 1 replacement
    expect(pm.status().free).toBe(2)
  })

  it("returns ok:false when the pool is empty (caller falls back)", async () => {
    const { fly } = makeFly({ createPooled: async () => { throw new Error("fly down") } })
    const pm = new PoolManager({ fly, config: CONFIG, postRun: async () => true })
    const res = await pm.claim(JOB)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/empty/)
  })

  it("destroys and fails when the woken machine rejects the job", async () => {
    const { fly, destroyed } = makeFly()
    const pm = new PoolManager({ fly, config: CONFIG, postRun: async () => false })
    await pm.refill()
    const res = await pm.claim(JOB)
    expect(res.ok).toBe(false)
    expect(destroyed.length).toBeGreaterThan(0)
  })

  it("never hands the same machine to two concurrent claims", async () => {
    // Boot exactly one free machine, then fire two claims at once.
    const { fly } = makeFly()
    const pm = new PoolManager({ fly, config: { ...CONFIG, min: 1 }, postRun: async () => true })
    await pm.refill()
    expect(pm.status().free).toBe(1)
    const [a, b] = await Promise.all([pm.claim(JOB), pm.claim({ ...JOB, jobId: "j2" })])
    const oks = [a, b].filter((r) => r.ok)
    // At most one claim can win the single warm machine; the other falls back.
    // (The winner's machineId is unique.)
    const winnerIds = oks.map((r) => r.machineId)
    expect(new Set(winnerIds).size).toBe(winnerIds.length)
  })
})

describe("PoolManager.reconcile", () => {
  it("adopts suspended machines as free, then refills", async () => {
    const existing: FlyMachine[] = [{ id: "old1", state: "suspended", private_ip: "fdaa::9" }]
    const { fly, created } = makeFly({ listPooled: async () => existing })
    const pm = new PoolManager({ fly, config: CONFIG, postRun: async () => true })
    await pm.reconcile()
    // adopted 1 + booted 1 more to reach min=2
    expect(pm.status().free).toBe(2)
    expect(created).toHaveLength(1)
  })
})
