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

/** Max free machines a single claim will try before falling back to create-fresh. */
const MAX_CLAIM_ATTEMPTS = 3

export interface PoolConfig {
  min: number
  image: string
  region: string
  guest: FlyGuest
  runnerApiKey: string
  litellmUrl?: string
  port: number
  healthTimeoutMs: number
  /** owner/repo tag — pooled machines are tagged with it so each repo's pool
   * (running in that repo's own Fly account) only manages its own machines. */
  repoTag: string
}

/** The job payload forwarded to a woken machine's POST /run. */
export interface PoolJob {
  jobId: string
  repo: string
  githubToken: string
  /** "issue" (one-shot run) | "interactive" (long-lived chat session)
   * | "scheduled" (duty/goal fan-out — Fly fallback for GitHub cron). */
  mode?: "issue" | "interactive" | "scheduled"
  /** Required for issue mode. */
  issueNumber?: number
  /** Required for interactive mode. */
  sessionId?: string
  idleExitMs?: number
  hardCapMs?: number
  ref?: string
  allSecrets?: Record<string, string>
  model?: string
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
   * Resize the warm target at runtime (per-repo, sourced from the repo's vault
   * POOL_MIN). Raising it warms up immediately via refill; lowering it just
   * stops topping up — surplus machines drain as they're claimed/auto-destroyed,
   * never force-killed. No-op when unchanged or given a bad value.
   */
  setMin(min: number): void {
    if (!Number.isInteger(min) || min < 0) return
    if (min === this.deps.config.min) return
    this.deps.config.min = min
    this.log(`min set to ${min}`)
    void this.refill()
  }

  /**
   * Adopt existing pooled machines on owner (re)start: suspended ones become
   * free; anything else is left to finish/auto-destroy. Then refill to `min`.
   */
  async reconcile(): Promise<void> {
    const machines = await this.deps.fly.listPooled(this.deps.config.repoTag)
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
   * Claim a warm machine for a job. Tries free machines in turn: if a woken
   * machine is stale/unhealthy/rejecting (e.g. it vanished out-of-band), it's
   * destroyed and the next free one is tried, up to MAX_CLAIM_ATTEMPTS. Only
   * when none work (or the pool is empty) does it return ok:false so the
   * caller falls back to create-fresh. The pick (shift) is synchronous — the
   * atomic step that prevents two concurrent claims grabbing the same machine.
   */
  async claim(job: PoolJob): Promise<ClaimResult> {
    let lastReason = "pool empty"
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const machine = this.free.shift() // ← atomic: no await before this
      if (!machine) break
      this.claimsInFlight++
      try {
        await this.deps.fly.start(machine.id)
        const healthy = await this.deps.fly.waitHealthy(this.baseUrl(machine), {
          timeoutMs: this.deps.config.healthTimeoutMs,
        })
        if (!healthy) {
          this.log(`claim: machine ${machine.id} unhealthy after wake — destroying, trying next`)
          await this.safeDestroy(machine.id)
          lastReason = "woken machine unhealthy"
          continue
        }
        const accepted = await this.postRun(machine, job, this.deps.config)
        if (!accepted) {
          this.log(`claim: machine ${machine.id} rejected job — destroying, trying next`)
          await this.safeDestroy(machine.id)
          lastReason = "machine rejected job"
          continue
        }
        this.log(`claim: machine ${machine.id} took job ${job.jobId}`)
        void this.refill()
        return { ok: true, machineId: machine.id }
      } catch (err) {
        // A start on a vanished/destroyed machine throws here — drop it and
        // try the next free one instead of failing the whole claim.
        this.log(`claim: error on ${machine.id}: ${errMsg(err)} — destroying, trying next`)
        await this.safeDestroy(machine.id)
        lastReason = errMsg(err)
      } finally {
        this.claimsInFlight--
      }
    }
    void this.refill()
    return { ok: false, reason: lastReason }
  }

  /**
   * Periodic self-heal: reconcile the in-memory free list against actual Fly
   * state. Prunes free entries whose machine vanished out-of-band (auto-destroy
   * after a job, manual ops) so a later claim never tries a dead machine, and
   * adopts any suspended machines we lost track of. Then tops up. Unlike
   * reconcile() this MERGES rather than rebuilds, so it won't drop a machine
   * that's momentarily not yet reflected as suspended by Fly's eventual
   * consistency.
   */
  async resync(): Promise<void> {
    let machines: FlyMachine[]
    try {
      machines = await this.deps.fly.listPooled(this.deps.config.repoTag)
    } catch (err) {
      this.log(`resync: listPooled failed: ${errMsg(err)}`)
      return
    }
    const liveIds = new Set(machines.map((m) => m.id))
    const before = this.free.length
    // Prune free entries Fly no longer has (destroyed/gone).
    this.free = this.free.filter((f) => liveIds.has(f.id))
    const pruned = before - this.free.length
    // Adopt suspended machines we aren't already tracking as free.
    const tracked = new Set(this.free.map((f) => f.id))
    let adopted = 0
    for (const m of machines) {
      if ((m.state === "suspended" || m.state === "suspending") && m.private_ip && !tracked.has(m.id)) {
        this.free.push({ id: m.id, privateIp: m.private_ip })
        adopted++
      }
    }
    if (pruned > 0 || adopted > 0) {
      this.log(`resync: pruned ${pruned} stale, adopted ${adopted} (free=${this.free.length})`)
    }
    await this.refill()
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
      repoTag: cfg.repoTag,
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
