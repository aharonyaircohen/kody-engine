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

import { FlyClient } from "./fly.js"
import { PoolManager, type PoolJob, type ClaimResult } from "./manager.js"
import { readRepoSecret, readRepoSecrets } from "./vault.js"

/**
 * Slim claim request from the dashboard — carries NO secrets. The owner fills
 * in the GitHub clone token (operator) and provider keys (the repo's vault)
 * itself, so secrets reach the runner via the vault, not over the wire.
 */
export interface ClaimRequest {
  jobId: string
  /** owner/name */
  repo: string
  issueNumber: number
  ref?: string
  model?: string
  sessionId?: string
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
    litellmUrl: string
    port: number
    healthTimeoutMs: number
    /** Fly app name (in each repo's own account). */
    app: string
  }
  /** Resolve a repo's Fly token. Injectable for tests; defaults to vault read. */
  resolveFlyToken?: (owner: string, repo: string) => Promise<string | null>
  log?: (msg: string) => void
}

export class PoolRegistry {
  private pools = new Map<string, PoolManager>()
  private readonly resolveFlyToken: (owner: string, repo: string) => Promise<string | null>
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
  }

  private key(owner: string, repo: string): string {
    return `${owner}/${repo}`.toLowerCase()
  }

  /** Get-or-create the pool for a repo, or null if the repo has no Fly token. */
  private async getPool(owner: string, repo: string): Promise<PoolManager | null> {
    const repoTag = this.key(owner, repo)
    const existing = this.pools.get(repoTag)
    if (existing) return existing

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

    const fly = new FlyClient({ token: flyToken, app: this.cfg.base.app })
    const pm = new PoolManager({
      fly,
      config: { ...this.cfg.base, repoTag },
      log: (m) => this.log(`[${repoTag}] ${m}`),
    })
    this.pools.set(repoTag, pm)
    // Adopt any existing frozen machines for this repo + top up.
    void pm.reconcile().catch((err) => this.log(`[${repoTag}] reconcile: ${err instanceof Error ? err.message : String(err)}`))
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
      allSecrets = Object.fromEntries(Object.entries(vault).filter(([k]) => k !== "FLY_API_TOKEN"))
    } catch (err) {
      this.log(`[${this.key(owner, repo)}] vault secrets read failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    const job: PoolJob = {
      jobId: req.jobId,
      repo: `${owner}/${repo}`,
      issueNumber: req.issueNumber,
      githubToken: this.cfg.githubToken,
      ref: req.ref,
      allSecrets,
      model: req.model,
      sessionId: req.sessionId,
      dashboardUrl: req.dashboardUrl,
    }
    return pm.claim(job)
  }

  /** Status for a single repo's pool, or null if none exists yet. */
  status(owner: string, repo: string): ReturnType<PoolManager["status"]> | null {
    return this.pools.get(this.key(owner, repo))?.status() ?? null
  }

  /** Resync every active repo pool (periodic self-heal). */
  async resyncAll(): Promise<void> {
    for (const [repoTag, pm] of this.pools) {
      await pm.resync().catch((err) => this.log(`[${repoTag}] resync: ${err instanceof Error ? err.message : String(err)}`))
    }
  }

  activeRepos(): string[] {
    return [...this.pools.keys()]
  }
}
