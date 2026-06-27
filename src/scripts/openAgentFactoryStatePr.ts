import type { Context, PostflightScript } from "../executables/types.js"
import { gh } from "../issue.js"
import { normalizeStatePath, parseStateRepo, stateRepoPath } from "../stateRepo.js"

interface AgentFactoryFile {
  path: string
  content: string
}

interface AgentFactoryBundle {
  title: string
  summary: string
  files: AgentFactoryFile[]
}

interface GitRefResponse {
  object?: {
    sha?: string
  }
}

interface GitCommitResponse {
  tree?: {
    sha?: string
  }
}

interface GitShaResponse {
  sha?: string
}

interface PullResponse {
  html_url?: string
  number?: number
}

export const openAgentFactoryStatePr: PostflightScript = async (ctx, _profile, agentResult) => {
  if (agentResult?.outcome !== "completed") {
    throw new Error(`openAgentFactoryStatePr: agent did not complete: ${agentResult?.error ?? "unknown failure"}`)
  }
  if (ctx.data.agentDone !== true) {
    throw new Error("openAgentFactoryStatePr: agent did not produce a successful final result")
  }
  if (!ctx.config.state?.repo || !ctx.config.state?.path) {
    throw new Error("openAgentFactoryStatePr: config.state.repo and config.state.path are required")
  }

  const issueNumber = readIssueNumber(ctx)
  const bundle = parseAgentFactoryBundle(String(ctx.data.prSummary ?? ""))
  const normalizedFiles = normalizeBundleFiles(ctx, bundle)
  const stateRepo = parseStateRepo(ctx.config)
  const baseBranch = "main"
  const branch = buildAgentFactoryBranchName(issueNumber, bundle.title)

  const baseRef = ghJson<GitRefResponse>(
    ["api", `/repos/${stateRepo.owner}/${stateRepo.repo}/git/ref/heads/${baseBranch}`],
    ctx.cwd,
  )
  const baseSha = requireString(
    baseRef.object?.sha,
    `state repo ${stateRepo.owner}/${stateRepo.repo} ${baseBranch} ref sha`,
  )
  const baseCommit = ghJson<GitCommitResponse>(
    ["api", `/repos/${stateRepo.owner}/${stateRepo.repo}/git/commits/${baseSha}`],
    ctx.cwd,
  )
  const baseTreeSha = requireString(
    baseCommit.tree?.sha,
    `state repo ${stateRepo.owner}/${stateRepo.repo} base tree sha`,
  )

  ghJson(["api", "--method", "POST", `/repos/${stateRepo.owner}/${stateRepo.repo}/git/refs`, "--input", "-"], ctx.cwd, {
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  })

  const tree = ghJson<GitShaResponse>(
    ["api", "--method", "POST", `/repos/${stateRepo.owner}/${stateRepo.repo}/git/trees`, "--input", "-"],
    ctx.cwd,
    {
      base_tree: baseTreeSha,
      tree: normalizedFiles.map((file) => ({
        path: file.targetPath,
        mode: "100644",
        type: "blob",
        content: file.content,
      })),
    },
  )
  const treeSha = requireString(tree.sha, "created tree sha")

  const commit = ghJson<GitShaResponse>(
    ["api", "--method", "POST", `/repos/${stateRepo.owner}/${stateRepo.repo}/git/commits`, "--input", "-"],
    ctx.cwd,
    {
      message: `agent-factory: ${bundle.title}`,
      tree: treeSha,
      parents: [baseSha],
    },
  )
  const commitSha = requireString(commit.sha, "created commit sha")

  ghJson(
    [
      "api",
      "--method",
      "PATCH",
      `/repos/${stateRepo.owner}/${stateRepo.repo}/git/refs/heads/${branch}`,
      "--input",
      "-",
    ],
    ctx.cwd,
    {
      sha: commitSha,
      force: false,
    },
  )

  const pr = ghJson<PullResponse>(
    ["api", "--method", "POST", `/repos/${stateRepo.owner}/${stateRepo.repo}/pulls`, "--input", "-"],
    ctx.cwd,
    {
      title: `agent-factory: ${bundle.title}`,
      head: branch,
      base: baseBranch,
      body: renderPullRequestBody(ctx, bundle, normalizedFiles),
    },
  )
  const prUrl = requireString(pr.html_url, "created pull request url")

  gh(["issue", "comment", String(issueNumber), "--body-file", "-"], {
    cwd: ctx.cwd,
    input: renderIssueComment(stateRepo.owner, stateRepo.repo, prUrl, bundle),
  })

  ctx.data.agentFactoryStatePr = {
    repo: `${stateRepo.owner}/${stateRepo.repo}`,
    branch,
    base: baseBranch,
    url: prUrl,
    number: pr.number,
    files: normalizedFiles.map((file) => file.targetPath),
  }
  ctx.output.prUrl = prUrl
}

export function parseAgentFactoryBundle(raw: string): AgentFactoryBundle {
  const jsonText = stripJsonFence(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    throw new Error(
      `openAgentFactoryStatePr: PR_SUMMARY must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("openAgentFactoryStatePr: PR_SUMMARY must be a JSON object")
  }
  const value = parsed as Record<string, unknown>
  const title = readRequiredJsonString(value.title, "title")
  const summary = readRequiredJsonString(value.summary, "summary")
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error("openAgentFactoryStatePr: files must be a non-empty array")
  }

  const files = value.files.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`openAgentFactoryStatePr: files[${index}] must be an object`)
    }
    const file = item as Record<string, unknown>
    return {
      path: readRequiredJsonString(file.path, `files[${index}].path`),
      content: readJsonString(file.content, `files[${index}].content`),
    }
  })

  return { title, summary, files }
}

export function buildAgentFactoryBranchName(issueNumber: number, title: string, now: number = Date.now()): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "")
  const suffix = slug ? `-${slug}` : ""
  return `agent-factory/issue-${issueNumber}-${now.toString(36)}${suffix}`
}

function normalizeBundleFiles(
  ctx: Context,
  bundle: AgentFactoryBundle,
): Array<AgentFactoryFile & { targetPath: string }> {
  const seen = new Set<string>()
  return bundle.files.map((file, index) => {
    if (file.path.startsWith("/") || file.path.includes("\\")) {
      throw new Error(`openAgentFactoryStatePr: files[${index}].path must be a relative POSIX path`)
    }
    const normalizedPath = normalizeStatePath(file.path, `files[${index}].path`)
    const relativePath = normalizedPath.replace(/^\.kody\/?/, "")
    if (!relativePath) {
      throw new Error(`openAgentFactoryStatePr: files[${index}].path must point to a state repo file`)
    }
    if (seen.has(relativePath)) {
      throw new Error(`openAgentFactoryStatePr: duplicate generated file path: ${relativePath}`)
    }
    seen.add(relativePath)
    return {
      ...file,
      path: relativePath,
      targetPath: stateRepoPath(ctx.config, relativePath),
    }
  })
}

function stripJsonFence(raw: string): string {
  const text = raw.trim()
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)
  return (fence ? fence[1]! : text).trim()
}

function readIssueNumber(ctx: Context): number {
  const issueNumber = ctx.args.issue
  if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("openAgentFactoryStatePr: ctx.args.issue must be a positive integer")
  }
  return issueNumber
}

function readRequiredJsonString(value: unknown, field: string): string {
  const text = readJsonString(value, field).trim()
  if (!text) throw new Error(`openAgentFactoryStatePr: ${field} must be a non-empty string`)
  return text
}

function readJsonString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`openAgentFactoryStatePr: ${field} must be a string`)
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`openAgentFactoryStatePr: missing ${label}`)
  }
  return value
}

function ghJson<T>(args: string[], cwd: string, input?: unknown): T {
  const raw = gh(args, input === undefined ? { cwd } : { cwd, input: JSON.stringify(input) })
  if (!raw) return {} as T
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    throw new Error(
      `openAgentFactoryStatePr: gh api returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function renderPullRequestBody(
  ctx: Context,
  bundle: AgentFactoryBundle,
  files: Array<AgentFactoryFile & { targetPath: string }>,
): string {
  const issueNumber = readIssueNumber(ctx)
  return [
    "Agent factory generated a Kody agency model bundle for review.",
    "",
    `Source issue: ${ctx.config.github.owner}/${ctx.config.github.repo}#${issueNumber}`,
    "",
    "## Summary",
    "",
    bundle.summary,
    "",
    "## Files",
    "",
    ...files.map((file) => `- \`${file.targetPath}\``),
    "",
    "Generated definitions are inactive until this state-repo PR is reviewed and merged.",
  ].join("\n")
}

function renderIssueComment(owner: string, repo: string, prUrl: string, bundle: AgentFactoryBundle): string {
  return [
    `agent-factory opened a state-repo review PR: ${prUrl}`,
    "",
    `State repo: ${owner}/${repo}`,
    "",
    "Summary:",
    bundle.summary,
  ].join("\n")
}
