/**
 * PoolManager — the single in-memory owner of warm pooled runners.
 *
 * Because the pool owner is ONE always-on process, the claim is just a
 * synchronous array shift: two concurrent claims can never grab the same
 * machine (no await before the pick), which is exactly why co-locating a
 * single owner sidesteps the distributed-lock problem a serverless pool
 * would have.
 *
 * Lifecycle of a pooled machine:
 *   create → boot (runner-serve, idle) → waitHealthy → suspend  ⇒ "free"
 *   claim  → start (~1s wake) → waitHealthy → POST /run         ⇒ gone
 *            (the machine runs one issue, then exits → Fly auto_destroy)
 *   refill keeps free-count at `min`.
 */

import { FlyClient, type FlyGuest, type FlyMachine } from "./fly.js"

export interface PoolConfig {
  min: number
  image: string
  region: string
  guest: FlyGuest
  runnerApiKey: string
  litellmUrl: string
  port: number
  healthTimeoutMs: number
}

/** The job payload forwarded to a woken machine's POST /run. */
export interface PoolJob {
  jobId: string
  repo: string
  issueNumber: number
  githubToken: string
  ref?: string
  allSecrets?: Record<string, string>
  model?: string
  sessionId?: string
  dashboardUrl?: string
}

export interface ClaimResult {
  ok: boolean
  machineId?: string
  reason?: string
}

interface FreeMachine {
  id: string
  privateIp: string
}

export interface PoolManagerDeps {
  fly: FlyClient
  config: PoolConfig
  /** POST the job to a woken machine. Injectable for tests. */
  postRun?: (machine: FreeMachine, job: PoolJob, cfg: PoolConfig) => Promise<boolean>
  log?: (msg: string) => void
}

export class PoolManager {
  private free: FreeMachine[] = []
  private booting = 0
  private claimsInFlight = 0
  private refilling = false
  private readonly postRun: (m: FreeMachine, j: PoolJob, c: PoolConfig) => Promise<boolean>
  private readonly log: (msg: string) => void

  constructor(private readonly deps: PoolManagerDeps) {
    this.postRun = deps.postRun ?? defaultPostRun
    this.log = deps.log ?? (() => {})
  }

  status() {
    return {
      min: this.deps.config.min,
      free: this.free.length,
      booting: this.booting,
      claimsInFlight: this.claimsInFlight,
      total: this.free.length + this.booting + this.claimsInFlight,
    }
  }

  /**
   * Adopt existing pooled machines on owner (re)start: suspended ones become
   * free; anything else is left to finish/auto-destroy. Then refill to `min`.
   */
  async reconcile(): Promise<void> {
    const machines = await this.deps.fly.listPooled()
    this.free = []
    for (const m of machines) {
      if ((m.state === "suspended" || m.state === "suspending") && m.private_ip) {
        this.free.push({ id: m.id, privateIp: m.private_ip })
      }
    }
    this.log(`reconcile: adopted ${this.free.length} suspended machine(s)`)
    await this.refill()
  }

  /**
   * Claim a warm machine for a job. Returns ok:false (caller falls back to
   * create-fresh) when the pool is empty or the woken machine fails to take
   * the job. The pick is synchronous — the atomic step.
   */
  async claim(job: PoolJob): Promise<ClaimResult> {
    const machine = this.free.shift() // ← atomic: no await before this
    if (!machine) {
      this.log("claim: pool empty")
      void this.refill()
      return { ok: false, reason: "pool empty" }
    }
    this.claimsInFlight++
    try {
      await this.deps.fly.start(machine.id)
      const base = this.baseUrl(machine)
      const healthy = await this.deps.fly.waitHealthy(base, { timeoutMs: this.deps.config.healthTimeoutMs })
      if (!healthy) {
        this.log(`claim: machine ${machine.id} unhealthy after wake — destroying`)
        await this.safeDestroy(machine.id)
        return { ok: false, reason: "woken machine unhealthy" }
      }
      const accepted = await this.postRun(machine, job, this.deps.config)
      if (!accepted) {
        this.log(`claim: machine ${machine.id} rejected job — destroying`)
        await this.safeDestroy(machine.id)
        return { ok: false, reason: "machine rejected job" }
      }
      this.log(`claim: machine ${machine.id} took job ${job.jobId}`)
      return { ok: true, machineId: machine.id }
    } catch (err) {
      this.log(`claim: error on ${machine.id}: ${errMsg(err)} — destroying`)
      await this.safeDestroy(machine.id)
      return { ok: false, reason: errMsg(err) }
    } finally {
      this.claimsInFlight--
      void this.refill()
    }
  }

  /** Top up free machines to `min`. Serialized so it never overshoots. */
  async refill(): Promise<void> {
    if (this.refilling) return
    this.refilling = true
    try {
      while (this.free.length + this.booting < this.deps.config.min) {
        this.booting++
        try {
          await this.bootOne()
        } catch (err) {
          this.log(`refill: boot failed: ${errMsg(err)}`)
          // Stop the loop on error to avoid hammering Fly; next claim/tick retries.
          this.booting--
          break
        }
        this.booting--
      }
    } finally {
      this.refilling = false
    }
  }

  private async bootOne(): Promise<void> {
    const cfg = this.deps.config
    const m: FlyMachine = await this.deps.fly.createPooled({
      image: cfg.image,
      region: cfg.region,
      guest: cfg.guest,
      runnerApiKey: cfg.runnerApiKey,
      litellmUrl: cfg.litellmUrl,
      port: cfg.port,
    })
    if (!m.private_ip) {
      // Re-fetch once; create may return before the IP is populated.
      const refreshed = await this.deps.fly.get(m.id)
      if (refreshed?.private_ip) m.private_ip = refreshed.private_ip
    }
    if (!m.private_ip) {
      await this.safeDestroy(m.id)
      throw new Error(`machine ${m.id} has no private_ip`)
    }
    const free: FreeMachine = { id: m.id, privateIp: m.private_ip }
    const healthy = await this.deps.fly.waitHealthy(this.baseUrl(free), { timeoutMs: cfg.healthTimeoutMs })
    if (!healthy) {
      await this.safeDestroy(m.id)
      throw new Error(`machine ${m.id} never became healthy`)
    }
    await this.deps.fly.suspend(m.id)
    this.free.push(free)
    this.log(`refill: machine ${m.id} booted, frozen, ready (free=${this.free.length})`)
  }

  private baseUrl(m: FreeMachine): string {
    return `http://[${m.privateIp}]:${this.deps.config.port}`
  }

  private async safeDestroy(id: string): Promise<void> {
    try {
      await this.deps.fly.destroy(id)
    } catch (err) {
      this.log(`destroy ${id} failed: ${errMsg(err)}`)
    }
  }
}

async function defaultPostRun(m: FreeMachine, job: PoolJob, cfg: PoolConfig): Promise<boolean> {
  const res = await fetch(`http://[${m.privateIp}]:${cfg.port}/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.runnerApiKey,
    },
    body: JSON.stringify(job),
    signal: AbortSignal.timeout(15_000),
  })
  return res.status === 202
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
