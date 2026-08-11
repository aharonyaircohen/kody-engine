export interface LiveReleaseGateConfig {
  dashboardUrl: string
  owner: string
  repo: string
  token: string
  workflowId: string
  timeoutMs: number
  pollMs: number
}

export interface LiveReleaseGateResult {
  runId: string
  githubRunId: number
  githubRunUrl: string
  agencyRunId: string
  dashboardRunsUrl: string
}

interface Dependencies {
  fetch: typeof globalThis.fetch
  sleep: (milliseconds: number) => Promise<void>
}

interface GitHubRun {
  id: number
  status: string
  conclusion: string | null
  html_url: string
}

const defaultDependencies: Dependencies = {
  fetch: globalThis.fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

export async function runLiveReleaseGate(
  config: LiveReleaseGateConfig,
  dependencies: Dependencies = defaultDependencies,
): Promise<LiveReleaseGateResult> {
  const dashboardUrl = config.dashboardUrl.replace(/\/+$/, "")
  const dashboardHeaders = {
    "content-type": "application/json",
    "x-kody-token": config.token,
    "x-kody-owner": config.owner,
    "x-kody-repo": config.repo,
  }
  const githubHeaders = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${config.token}`,
    "x-github-api-version": "2022-11-28",
  }
  const githubRunsUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/actions/workflows/kody.yml/runs?event=workflow_dispatch&per_page=20`
  const previousRuns = await readGitHubRuns(dependencies.fetch, githubRunsUrl, githubHeaders)
  const previousIds = new Set(previousRuns.map((run) => run.id))

  await requestJson(dependencies.fetch, `${dashboardUrl}/api/kody/store-catalog/import`, {
    method: "POST",
    headers: dashboardHeaders,
    body: JSON.stringify({ kind: "workflow", slug: config.workflowId }),
  })

  const listed = await requestJson(dependencies.fetch, `${dashboardUrl}/api/kody/company/workflows`, {
    headers: dashboardHeaders,
  })
  const workflows = Array.isArray(listed.workflows) ? listed.workflows : []
  const workflow = workflows.find((candidate) => isRecord(candidate) && candidate.id === config.workflowId)
  if (
    !isRecord(workflow) ||
    workflow.source !== "store" ||
    workflow.runnable !== true ||
    !isRecord(workflow.automation) ||
    workflow.automation.eligible !== true
  ) {
    throw new Error(`Store workflow "${config.workflowId}" is not installed and runnable`)
  }

  const accepted = await requestJson(
    dependencies.fetch,
    `${dashboardUrl}/api/kody/company/workflows/${encodeURIComponent(config.workflowId)}/run`,
    { method: "POST", headers: dashboardHeaders, body: JSON.stringify({ input: {} }) },
  )
  const runId = string(accepted.runId)
  if (!runId) throw new Error("Dashboard accepted the workflow without returning a run id")

  const deadline = Date.now() + config.timeoutMs
  const githubRun = await pollUntil(
    deadline,
    config.pollMs,
    dependencies.sleep,
    async () => {
      const runs = await readGitHubRuns(dependencies.fetch, githubRunsUrl, githubHeaders)
      const newRuns = runs.filter((run) => !previousIds.has(run.id))
      if (newRuns.length > 1) {
        throw new Error("More than one new manual kody run appeared; the release run is ambiguous")
      }
      const run = newRuns[0]
      if (!run || run.status !== "completed") return null
      if (run.conclusion !== "success") {
        throw new Error(`GitHub run ${run.id} failed with conclusion ${run.conclusion ?? "unknown"}`)
      }
      return run
    },
    "GitHub Actions did not finish the release workflow",
  )

  await pollUntil(
    deadline,
    config.pollMs,
    dependencies.sleep,
    async () => {
      const query = new URLSearchParams({ runId }).toString()
      const payload = await requestJson(
        dependencies.fetch,
        `${dashboardUrl}/api/kody/company/workflows/${encodeURIComponent(config.workflowId)}/runs?${query}`,
        { headers: dashboardHeaders },
      )
      const record = isRecord(payload.run) ? payload.run : null
      const state = record && isRecord(record.state) ? record.state : null
      if (!state || state.status === "running") return null
      if (state.status !== "done") {
        throw new Error(`Workflow state ended as ${string(state.status) ?? "unknown"}`)
      }
      return state
    },
    "Dashboard workflow state did not complete",
  )

  const agencyRunId = `workflow:${config.workflowId}:${runId}`
  await pollUntil(
    deadline,
    config.pollMs,
    dependencies.sleep,
    async () => {
      const payload = await requestJson(dependencies.fetch, `${dashboardUrl}/api/kody/agency-runs?limit=100`, {
        headers: dashboardHeaders,
      })
      const runs = Array.isArray(payload.runs) ? payload.runs : []
      const run = runs.find((candidate) => isRecord(candidate) && candidate.id === agencyRunId)
      if (!isRecord(run)) return null
      if (run.status !== "success") {
        throw new Error(`Dashboard Agency Run ended as ${string(run.status) ?? "unknown"}`)
      }
      return run
    },
    "The successful workflow did not appear in Dashboard Agency Runs",
  )

  return {
    runId,
    githubRunId: githubRun.id,
    githubRunUrl: githubRun.html_url,
    agencyRunId,
    dashboardRunsUrl: `${dashboardUrl}/repo/${config.owner}/${config.repo}/agency-runs`,
  }
}

async function readGitHubRuns(
  fetch: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
): Promise<GitHubRun[]> {
  const payload = await requestJson(fetch, url, { headers })
  if (!Array.isArray(payload.workflow_runs)) return []
  return payload.workflow_runs.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "number") return []
    const htmlUrl = string(candidate.html_url)
    const status = string(candidate.status)
    if (!htmlUrl || !status) return []
    return [
      {
        id: candidate.id,
        status,
        conclusion: string(candidate.conclusion),
        html_url: htmlUrl,
      },
    ]
  })
}

async function requestJson(
  fetch: typeof globalThis.fetch,
  url: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init)
  const text = await response.text()
  let payload: unknown = {}
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`${url} returned invalid JSON`)
    }
  }
  if (!response.ok) {
    const message = isRecord(payload) ? (string(payload.message) ?? string(payload.error)) : null
    throw new Error(`${url} failed (${response.status})${message ? `: ${message}` : ""}`)
  }
  if (!isRecord(payload)) throw new Error(`${url} returned an invalid response`)
  return payload
}

async function pollUntil<T>(
  deadline: number,
  pollMs: number,
  sleep: (milliseconds: number) => Promise<void>,
  check: () => Promise<T | null>,
  timeoutMessage: string,
): Promise<T> {
  for (;;) {
    const result = await check()
    if (result !== null) return result
    if (Date.now() >= deadline) throw new Error(timeoutMessage)
    await sleep(pollMs)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}
