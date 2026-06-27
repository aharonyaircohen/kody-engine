/**
 * Capability fan-out fallback tick (runs inside pool-serve on the always-on machine).
 *
 * GitHub Actions' cron normally fires the scheduled capability/goal fan-out every
 * 15 min. When GitHub Actions is DOWN that cron never fires, so capabilities stall.
 * This tick is the fallback: while the always-on pool machine is awake, it
 * checks GitHub health and — only when GitHub is degraded — runs the scheduled
 * fan-out target on a Fly runner for each active repo.
 *
 * GitHub stays the default: we do nothing while it's healthy. And the engine's
 * per-capability cadence guard (`lastFiredAt` vs `every:`) means that even if GitHub
 * recovers mid-window and both fire, a capability won't run twice.
 *
 * Kept dependency-injected (no direct PoolRegistry / fetch import) so it's
 * unit-testable without network or a live pool.
 */

export interface CapabilityTickClaimResult {
  ok: boolean
  machineId?: string
  reason?: string
}

export interface CapabilityFallbackDeps {
  /** True when GitHub Actions is degraded (engine github-health probe). */
  isDegraded: () => Promise<boolean>
  /** Repo tags ("owner/repo") that currently have a warm pool. */
  activeRepos: () => string[]
  /** Claim a runner and post the job; mirrors PoolRegistry.claim. */
  claim: (
    owner: string,
    repo: string,
    req: {
      jobId: string
      repo: string
      runRequest: {
        target: { type: "workflow"; id: "scheduled-fanout" }
        intent: "tick"
        source: "schedule"
      }
    },
  ) => Promise<CapabilityTickClaimResult>
  log: (msg: string) => void
  /** Injectable clock for deterministic jobIds in tests. */
  now?: () => number
}

export interface CapabilityTickResult {
  /** False when GitHub was healthy (we deferred to its cron). */
  ran: boolean
  /** How many repos successfully claimed a scheduled runner. */
  claimed: number
}

export async function runCapabilityFallbackTick(
  deps: CapabilityFallbackDeps,
): Promise<CapabilityTickResult> {
  if (!(await deps.isDegraded())) {
    return { ran: false, claimed: 0 }
  }
  const repos = deps.activeRepos()
  if (repos.length === 0) {
    deps.log("GitHub Actions degraded but no active repo pools — nothing to tick")
    return { ran: true, claimed: 0 }
  }

  deps.log(`GitHub Actions degraded — running scheduled fan-out on Fly for ${repos.length} repo(s)`)
  const clock = deps.now ?? Date.now
  let claimed = 0
  for (const tag of repos) {
    const [owner, repo] = tag.split("/")
    if (!owner || !repo) continue
    try {
      const res = await deps.claim(owner, repo, {
        jobId: `sched-${owner}-${repo}-${clock()}`,
        repo: tag,
        runRequest: {
          target: { type: "workflow", id: "scheduled-fanout" },
          intent: "tick",
          source: "schedule",
        },
      })
      if (res.ok) {
        claimed++
        deps.log(`[${tag}] scheduled fan-out claimed ${res.machineId}`)
      } else {
        deps.log(`[${tag}] scheduled fan-out skipped: ${res.reason ?? "pool unavailable"}`)
      }
    } catch (err) {
      deps.log(`[${tag}] scheduled fan-out error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { ran: true, claimed }
}
