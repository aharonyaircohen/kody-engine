import { execFileSync } from "node:child_process"

const GH_TIMEOUT_MS = 30_000

function ghToken(): string | undefined {
  return process.env.GH_PAT?.trim() || process.env.GH_TOKEN
}

function gh(args: string[], cwd?: string): string {
  const token = ghToken()
  const env: NodeJS.ProcessEnv = token ? { ...process.env, GH_TOKEN: token } : { ...process.env }
  return execFileSync("gh", args, {
    encoding: "utf-8",
    timeout: GH_TIMEOUT_MS,
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

export interface FailedRun {
  id: string
  workflowName: string
  headBranch: string
  headSha: string
  conclusion: string
  url: string
  createdAt: string
}

/**
 * Fetch recent failed workflow runs for the PR's *current head commit*,
 * most-recent-first. Scoping to the head SHA (not just the branch) means
 * historical noise — especially kody's own dispatch reruns from earlier
 * commits — can never crowd the real CI failure out of the window.
 * Returns an empty array if the PR can't be resolved or the listing fails.
 */
export function getRecentFailedRunsForPr(prNumber: number, limit: number, cwd?: string): FailedRun[] {
  let headBranch: string
  let headSha: string
  try {
    const out = gh(["pr", "view", String(prNumber), "--json", "headRefName,headRefOid"], cwd)
    const parsed = JSON.parse(out)
    headBranch = parsed.headRefName
    headSha = parsed.headRefOid
  } catch {
    return []
  }
  if (!headBranch || !headSha) return []

  try {
    const out = gh(
      [
        "run",
        "list",
        "--branch",
        headBranch,
        "--status",
        "failure",
        "--limit",
        String(Math.max(1, limit)),
        "--json",
        "databaseId,workflowName,headBranch,headSha,conclusion,url,createdAt",
      ],
      cwd,
    )
    const parsed = JSON.parse(out)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((r) => ({
        id: String(r.databaseId ?? ""),
        workflowName: r.workflowName ?? "",
        headBranch: r.headBranch ?? headBranch,
        headSha: r.headSha ?? "",
        conclusion: r.conclusion ?? "failure",
        url: r.url ?? "",
        createdAt: r.createdAt ?? "",
      }))
      .filter((r) => r.headSha === headSha)
  } catch {
    return []
  }
}

/**
 * Fetch the failed-step log tail for a workflow run. Returns an empty
 * string on any error (caller decides how to handle).
 */
export function getFailedRunLogTail(runId: string, maxBytes: number, cwd?: string): string {
  try {
    const raw = gh(["run", "view", String(runId), "--log-failed"], cwd)
    if (raw.length <= maxBytes) return raw
    return raw.slice(-maxBytes)
  } catch {
    return ""
  }
}

/**
 * kody's own dispatch workflow is skipped by fix-ci — its failures are the
 * engine's own crashes, not the CI we're trying to repair. Match by name
 * (the template ships as `name: kody`).
 */
export function isKodyDispatchWorkflow(workflowName: string): boolean {
  return workflowName.trim().toLowerCase() === "kody"
}

/**
 * Pick the first recent failed run that fix-ci can act on:
 *   - not kody's own dispatch workflow
 *   - has a fetchable, non-empty `--log-failed` tail
 *
 * Returns the run plus its log tail, or null if nothing usable is found.
 */
export function pickFailedRunForFixCi(
  prNumber: number,
  maxBytes: number,
  limit: number,
  cwd?: string,
): { run: FailedRun; logTail: string } | null {
  const runs = getRecentFailedRunsForPr(prNumber, limit, cwd)
  for (const run of runs) {
    if (isKodyDispatchWorkflow(run.workflowName)) continue
    const logTail = getFailedRunLogTail(run.id, maxBytes, cwd)
    if (logTail) return { run, logTail }
  }
  return null
}
