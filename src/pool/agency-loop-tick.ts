/**
 * Infrastructure heartbeat for consumer-agency Loops.
 * Repository discovery is injected so the engine stays repo-agnostic.
 */

export interface AgencyLoopTickClaimResult {
  ok: boolean
  machineId?: string
  reason?: string
}

export interface AgencyLoopTickDeps {
  discover: () => Promise<string[]>
  claim: (
    owner: string,
    repo: string,
    req: {
      jobId: string
      repo: string
      runRequest: {
        requestId: string
        target: { type: "workflow"; id: "scheduled-fanout" }
        intent: "tick"
        source: "schedule"
      }
    },
  ) => Promise<AgencyLoopTickClaimResult>
  log: (message: string) => void
  now?: () => number
}

export interface AgencyLoopTickResult {
  discovered: number
  claimed: number
}

function normalizeRepositories(repositories: string[]): string[] {
  const unique = new Set<string>()
  for (const raw of repositories) {
    const repo = raw.trim().toLowerCase()
    if (/^[^/\s]+\/[^/\s]+$/.test(repo)) unique.add(repo)
  }
  return [...unique].sort()
}

export async function runAgencyLoopTick(deps: AgencyLoopTickDeps): Promise<AgencyLoopTickResult> {
  const repositories = normalizeRepositories(await deps.discover())
  if (repositories.length === 0) {
    deps.log("no consumer agencies discovered — nothing to tick")
    return { discovered: 0, claimed: 0 }
  }

  deps.log(
    `running scheduled fan-out for ${repositories.length} consumer agenc${repositories.length === 1 ? "y" : "ies"}`,
  )
  const clock = deps.now ?? Date.now
  let claimed = 0
  for (const repository of repositories) {
    const [owner, repo] = repository.split("/")
    try {
      const jobId = `sched-${owner}-${repo}-${clock()}`
      const result = await deps.claim(owner!, repo!, {
        jobId,
        repo: repository,
        runRequest: {
          requestId: jobId,
          target: { type: "workflow", id: "scheduled-fanout" },
          intent: "tick",
          source: "schedule",
        },
      })
      if (result.ok) {
        claimed++
        deps.log(`[${repository}] scheduled fan-out claimed ${result.machineId}`)
      } else {
        deps.log(`[${repository}] scheduled fan-out skipped: ${result.reason ?? "runner unavailable"}`)
      }
    } catch (error) {
      deps.log(`[${repository}] scheduled fan-out error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { discovered: repositories.length, claimed }
}
