/**
 * GitHub Actions health probe (engine side).
 *
 * Used by pool-serve's capability-tick to decide whether GitHub Actions can run the
 * scheduled fan-out, or whether the engine should run due capabilities on Fly itself.
 * Signal: GitHub's public status page Actions component. Fails OPEN (assume
 * operational) on any HTTP/parse error — a status-page hiccup must never make
 * the engine think GitHub is down and start duplicating GitHub's own cron work.
 *
 * Mirrors the dashboard's src/dashboard/lib/runners/github-health.ts, kept as a
 * separate copy because the engine is a standalone npm package (no shared dep).
 */

const STATUS_URL = "https://www.githubstatus.com/api/v2/components.json"
const STATUS_CACHE_TTL_MS = 30_000

export interface ActionsStatus {
  /** True when GitHub's status page lists Actions as not operational. */
  degraded: boolean
  /** The raw component status label (e.g. "operational", "major_outage"). */
  label: string
}

let statusCache: { probe: ActionsStatus; expiresAt: number } | null = null

/** Test seam: clear the shared 30s status cache. */
export function _resetGitHubHealthCache(): void {
  statusCache = null
}

/**
 * Probe githubstatus.com for the Actions component. Fail-open results
 * (degraded:false) are NOT cached, so a transient error retries soon; a
 * definite operational / non-operational answer is cached 30s.
 */
export async function probeActionsStatus(fetchImpl: typeof fetch = fetch): Promise<ActionsStatus> {
  if (statusCache && statusCache.expiresAt > Date.now()) return statusCache.probe
  try {
    const res = await fetchImpl(STATUS_URL, { headers: { "User-Agent": "kody-engine" } })
    if (!res.ok) return { degraded: false, label: `http_${res.status}` }
    const body = (await res.json()) as { components?: Array<{ name?: string; status?: string }> }
    const actions = (body.components ?? []).find((c) => (c.name ?? "").trim().toLowerCase() === "actions")
    const label = actions?.status ?? "unknown"
    const degraded = !!actions && label !== "operational"
    const probe: ActionsStatus = { degraded, label }
    statusCache = { probe, expiresAt: Date.now() + STATUS_CACHE_TTL_MS }
    return probe
  } catch {
    return { degraded: false, label: "probe_error" }
  }
}

/**
 * Convenience: true when GitHub Actions is NOT operational, i.e. the engine
 * should take over the scheduled fan-out on Fly.
 */
export async function gitHubActionsDegraded(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  return (await probeActionsStatus(fetchImpl)).degraded
}
