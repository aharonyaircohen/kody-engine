/**
 * PoolRegistry — one warm pool PER REPO, keyed by owner/repo.
 *
 * The dashboard is repo-scoped: each connected repo has its own vault with its
 * own FLY_API_TOKEN (→ its own Fly account/region). So the pool must be
 * per-repo too. The registry lazily creates a PoolManager for a repo on first
 * claim, resolving that repo's Fly token from its vault (read with the operator
 * GitHub token, decrypted with KODY_MASTER_KEY). Pooled machines are tagged
 * with the repo so pools never cross-claim each other's machines.
 *
 * Repos without FLY_API_TOKEN in their vault get no pool — claim returns
 * ok:false and the dashboard falls back to create-fresh / GitHub Actions.
 */

import type { RunRequest } from "../run-request.js"
import { FlyClient } from "./fly.js"
import { type ClaimResult, type PoolJob, PoolManager } from "./manager.js"
import { readRepoSecret, readRepoSecrets } from "./vault.js"

/** Vault key the dashboard writes to size a repo's warm pool. */
const POOL_MIN_VAULT_KEY = "POOL_MIN"
/** Hard ceiling on the vault-supplied warm-pool size — every warm machine is a
 * real (paid) Fly VM, so cap a fat-fingered value well below anything sane. */
const POOL_MIN_MAX = 10

/** Parse a vault POOL_MIN string into a clamped, non-negative integer, falling
 * back to the global default when unset/garbage. */
function parsePoolMin(raw: string | null | undefined, dflt: number): number {
  if (raw == null || raw.trim() === "") return dflt
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) return dflt
  return Math.min(n, POOL_MIN_MAX)
}

/**
 * Slim claim request from the dashboard — carries NO secrets. The owner fills
 * in the GitHub clone token (operator) and provider keys (the repo's vault)
 * itself, so secrets reach the runner via the vault, not over the wire.
 */
export interface ClaimRequest {
  jobId: string
  /** owner/name */
  repo: string
  /** Canonical target/intent contract. Legacy mode fields are normalized by pool-serve. */
  runRequest: RunRequest
  /** Required for issue mode. */
  issueNumber?: number
  /** Required for interactive mode. */
  sessionId?: string
  idleExitMs?: number
  hardCapMs?: number
  ref?: string
  model?: string
  dashboardUrl?: string
}

export interface RegistryConfig {
  /** Operator GitHub token used to read each repo's .kody/secrets.enc. */
  githubToken: string
  /** KODY_MASTER_KEY bytes — decrypts the vault. */
  masterKey: Buffer
  /** Per-pool config shared across repos EXCEPT the Fly token + repoTag. */
  base: {
    min: number
    image: string
    region: string
    guest: import("./fly.js").FlyGuest
    runnerApiKey: string
    port: number
    healthTimeoutMs: number
    /** Fly app name (in each repo's own account). */
    app: string
  }
  /** Resolve a repo's Fly token. Injectable for tests; defaults to vault read. */
  resolveFlyToken?: (owner: string, repo: string) => Promise<string | null>
  /** Resolve a repo's warm-pool size. Injectable for tests; defaults to reading
   * (clamped) POOL_MIN from the repo's vault, falling back to base.min. */
  resolvePoolMin?: (owner: string, repo: string) => Promise<number>
  log?: (msg: string) => void
}

export class PoolRegistry {
  private pools = new Map<string, PoolManager>()
  private poolCreates = new Map<string, Promise<PoolManager | null>>()
  private readonly resolveFlyToken: (owner: string, repo: string) => Promise<string | null>
  private readonly resolvePoolMin: (owner: string, repo: string) => Promise<number>
  private readonly log: (msg: string) => void

  constructor(private readonly cfg: RegistryConfig) {
    this.log = cfg.log ?? (() => {})
    this.resolveFlyToken =
      cfg.resolveFlyToken ??
      ((owner, repo) =>
        readRepoSecret({
          githubToken: cfg.githubToken,
          masterKey: cfg.masterKey,
          owner,
          repo,
          name: "FLY_API_TOKEN",
        }))
    this.resolvePoolMin =
      cfg.resolvePoolMin ??
      (async (owner, repo) =>
        parsePoolMin(
          await readRepoSecret({
            githubToken: cfg.githubToken,
            masterKey: cfg.masterKey,
            owner,
            repo,
            name: POOL_MIN_VAULT_KEY,
          }),
          cfg.base.min,
        ))
  }

  private key(owner: string, repo: string): string {
    return `${owner}/${repo}`.toLowerCase()
  }

  /** Get-or-create the pool for a repo, or null if the repo has no Fly token. */
  private async getPool(owner: string, repo: string): Promise<PoolManager | null> {
    const repoTag = this.key(owner, repo)
    const existing = this.pools.get(repoTag)
    if (existing) return existing

    const pending = this.poolCreates.get(repoTag)
    if (pending) return pending

    const creating = this.createPool(owner, repo, repoTag).finally(() => {
      this.poolCreates.delete(repoTag)
    })
    this.poolCreates.set(repoTag, creating)
    return creating
  }

  private async createPool(owner: string, repo: string, repoTag: string): Promise<PoolManager | null> {
    let flyToken: string | null
    try {
      flyToken = await this.resolveFlyToken(owner, repo)
    } catch (err) {
      this.log(`registry: vault read failed for ${repoTag}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    if (!flyToken) {
      this.log(`registry: ${repoTag} has no FLY_API_TOKEN — no pool`)
      return null
    }

    let min = this.cfg.base.min
    try {
      min = await this.resolvePoolMin(owner, repo)
    } catch (err) {
      this.log(
        `registry: pool-min read failed for ${repoTag}, using default ${min}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const fly = new FlyClient({ token: flyToken, app: this.cfg.base.app })
    const pm = new PoolManager({
      fly,
      config: { ...this.cfg.base, repoTag, min },
      log: (m) => this.log(`[${repoTag}] ${m}`),
    })
    this.pools.set(repoTag, pm)
    // Adopt any existing frozen machines for this repo + top up.
    void pm
      .reconcile()
      .catch((err) => this.log(`[${repoTag}] reconcile: ${err instanceof Error ? err.message : String(err)}`))
    return pm
  }

  async claim(owner: string, repo: string, req: ClaimRequest): Promise<ClaimResult> {
    const pm = await this.getPool(owner, repo)
    if (!pm) return { ok: false, reason: "repo has no FLY_API_TOKEN (no pool)" }

    // Pull the repo's provider keys from its vault (NOT FLY_API_TOKEN — that's
    // for pool ops, not the agent). The runner clones with the operator token.
    let allSecrets: Record<string, string> = {}
    try {
      const vault = await readRepoSecrets({
        githubToken: this.cfg.githubToken,
        masterKey: this.cfg.masterKey,
        owner,
        repo,
      })
      // POOL_MIN sizes the warm pool — apply the latest value now (so a resize
      // takes effect on the next claim, not just the 60s resync tick) and keep
      // it out of the job's secrets. FLY_API_TOKEN is pool-ops only, not a
      // runner provider key, so it's filtered too.
      pm.setMin(parsePoolMin(vault[POOL_MIN_VAULT_KEY], this.cfg.base.min))
      allSecrets = Object.fromEntries(
        Object.entries(vault).filter(([k]) => k !== "FLY_API_TOKEN" && k !== POOL_MIN_VAULT_KEY),
      )
    } catch (err) {
      this.log(
        `[${this.key(owner, repo)}] vault secrets read failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const job: PoolJob = {
      jobId: req.jobId,
      repo: `${owner}/${repo}`,
      githubToken: this.cfg.githubToken,
      runRequest: req.runRequest,
      issueNumber: req.issueNumber,
      sessionId: req.sessionId,
      idleExitMs: req.idleExitMs,
      hardCapMs: req.hardCapMs,
      ref: req.ref,
      allSecrets,
      model: req.model,
      dashboardUrl: req.dashboardUrl,
    }
    return pm.claim(job)
  }

  /** Status for a single repo's pool already known to this owner. */
  status(owner: string, repo: string): ReturnType<PoolManager["status"]> | null {
    return this.pools.get(this.key(owner, repo))?.status() ?? null
  }

  /**
   * Status for a repo, creating/adopting its pool on first read when the repo
   * has pool credentials. This lets a restarted owner recover from existing
   * pooled machines without waiting for the next claim.
   */
  async statusFor(owner: string, repo: string): Promise<ReturnType<PoolManager["status"]> | null> {
    const pm = await this.getPool(owner, repo)
    return pm?.status() ?? null
  }

  /** Resync every active repo pool (periodic self-heal). Also re-reads each
   * repo's POOL_MIN from its vault so a dashboard resize warms up/drains within
   * one tick — no owner restart needed. */
  async resyncAll(): Promise<void> {
    for (const [repoTag, pm] of this.pools) {
      const [owner, repo] = repoTag.split("/")
      try {
        pm.setMin(await this.resolvePoolMin(owner!, repo!))
      } catch (err) {
        this.log(`[${repoTag}] pool-min refresh: ${err instanceof Error ? err.message : String(err)}`)
      }
      await pm
        .resync()
        .catch((err) => this.log(`[${repoTag}] resync: ${err instanceof Error ? err.message : String(err)}`))
    }
  }

  activeRepos(): string[] {
    return [...this.pools.keys()]
  }
}
