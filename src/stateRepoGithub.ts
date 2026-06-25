import * as fs from "node:fs"
import * as path from "node:path"
import {
  normalizeStatePath,
  parseStateRepo,
  parseStateRepoSlug,
  type StateRepoConfig,
  stateRepoPath,
} from "./stateRepo.js"

const GITHUB_API = "https://api.github.com"
const REQ_TIMEOUT_MS = 30_000

export interface GithubStateConfig extends StateRepoConfig {
  github: {
    owner: string
    repo: string
  }
  state: {
    repo: string
    path: string
  }
}

export interface GithubStateFile {
  path: string
  content: string
  sha: string
}

interface ContentsFile {
  type?: string
  encoding?: string
  content?: string
  sha?: string
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function contentsUrl(owner: string, repo: string, filePath: string): string {
  const encodedPath = filePath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/")
  return `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`
}

async function githubContentsFile(opts: {
  owner: string
  repo: string
  path: string
  githubToken: string
  fetchImpl?: typeof fetch
}): Promise<ContentsFile | null> {
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(contentsUrl(opts.owner, opts.repo, opts.path), {
    headers: {
      Authorization: `Bearer ${opts.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "kody-engine",
    },
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(
      `GitHub ${opts.owner}/${opts.repo}:${opts.path}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`,
    )
  }
  return (await res.json()) as ContentsFile
}

function decodeContentsFile(file: ContentsFile, label: string): GithubStateFile {
  if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") {
    throw new Error(`${label} is not a base64 file`)
  }
  if (typeof file.sha !== "string") {
    throw new Error(`${label} response missing sha`)
  }
  return {
    path: label,
    content: Buffer.from(file.content, "base64").toString("utf-8"),
    sha: file.sha,
  }
}

export async function loadGithubStateConfig(opts: {
  owner: string
  repo: string
  githubToken: string
  fetchImpl?: typeof fetch
}): Promise<GithubStateConfig> {
  const configFile = await githubContentsFile({
    owner: opts.owner,
    repo: opts.repo,
    path: "kody.config.json",
    githubToken: opts.githubToken,
    fetchImpl: opts.fetchImpl,
  })

  let raw: Record<string, unknown> = {}
  if (configFile) {
    const decoded = decodeContentsFile(configFile, "kody.config.json")
    try {
      raw = JSON.parse(decoded.content) as Record<string, unknown>
    } catch (err) {
      throw new Error(`kody.config.json is invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const githubRaw = recordValue(raw.github) ?? {}
  const github = {
    owner: typeof githubRaw.owner === "string" && githubRaw.owner.trim() ? githubRaw.owner.trim() : opts.owner,
    repo: typeof githubRaw.repo === "string" && githubRaw.repo.trim() ? githubRaw.repo.trim() : opts.repo,
  }

  const nestedState = recordValue(raw.state) ?? {}
  const repoRaw = typeof raw.stateRepo === "string" ? raw.stateRepo : nestedState.repo
  const pathRaw = typeof raw.statePath === "string" ? raw.statePath : nestedState.path
  const stateRepo =
    typeof repoRaw === "string" && repoRaw.trim().length > 0
      ? repoRaw.trim()
      : `https://github.com/${github.owner}/kody-state`
  parseStateRepoSlug(stateRepo)
  const statePath = typeof pathRaw === "string" && pathRaw.trim().length > 0 ? pathRaw.trim() : github.repo

  return {
    github,
    state: {
      repo: stateRepo,
      path: normalizeStatePath(statePath),
    },
  }
}

export async function readGithubStateText(opts: {
  owner: string
  repo: string
  filePath: string
  githubToken: string
  fetchImpl?: typeof fetch
}): Promise<GithubStateFile | null> {
  const config = await loadGithubStateConfig(opts)
  return readGithubStateTextWithConfig({
    config,
    filePath: opts.filePath,
    githubToken: opts.githubToken,
    fetchImpl: opts.fetchImpl,
  })
}

export async function readGithubStateTextWithConfig(opts: {
  config: GithubStateConfig
  filePath: string
  githubToken: string
  fetchImpl?: typeof fetch
}): Promise<GithubStateFile | null> {
  const target = stateRepoPath(opts.config, opts.filePath)
  const parsed = parseStateRepo(opts.config)
  const file = await githubContentsFile({
    owner: parsed.owner,
    repo: parsed.repo,
    path: target,
    githubToken: opts.githubToken,
    fetchImpl: opts.fetchImpl,
  })
  return file ? decodeContentsFile(file, target) : null
}

export async function writeGithubStateTextWithConfig(opts: {
  config: GithubStateConfig
  filePath: string
  content: string
  message: string
  githubToken: string
  sha?: string
  fetchImpl?: typeof fetch
}): Promise<void> {
  const target = stateRepoPath(opts.config, opts.filePath)
  const parsed = parseStateRepo(opts.config)
  const payload: Record<string, unknown> = {
    message: opts.message,
    content: Buffer.from(opts.content, "utf-8").toString("base64"),
  }
  if (opts.sha) payload.sha = opts.sha

  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(contentsUrl(parsed.owner, parsed.repo, target), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${opts.githubToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "kody-engine",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(
      `GitHub write ${parsed.owner}/${parsed.repo}:${target}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`,
    )
  }
}

function jsonlLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0)
}

function renderJsonl(lines: string[]): string {
  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

function mergeJsonl(localText: string, remoteText: string): string {
  const remoteLines = jsonlLines(remoteText)
  const seen = new Set(remoteLines)
  const localOnly = jsonlLines(localText).filter((line) => !seen.has(line))
  return renderJsonl([...remoteLines, ...localOnly])
}

export async function syncJsonlFileFromGithubState(opts: {
  config: GithubStateConfig
  filePath: string
  localPath: string
  githubToken: string
  fetchImpl?: typeof fetch
}): Promise<void> {
  const remote = await readGithubStateTextWithConfig(opts)
  if (!remote) return
  const local = fs.existsSync(opts.localPath) ? fs.readFileSync(opts.localPath, "utf-8") : ""
  const next = mergeJsonl(local, remote.content)
  if (next === local) return
  fs.mkdirSync(path.dirname(opts.localPath), { recursive: true })
  fs.writeFileSync(opts.localPath, next)
}

export async function persistJsonlFileToGithubState(opts: {
  config: GithubStateConfig
  filePath: string
  localPath: string
  message: string
  githubToken: string
  fetchImpl?: typeof fetch
}): Promise<void> {
  if (!fs.existsSync(opts.localPath)) return
  const localText = fs.readFileSync(opts.localPath, "utf-8")

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const remote = await readGithubStateTextWithConfig(opts)
    const body = mergeJsonl(localText, remote?.content ?? "")
    try {
      await writeGithubStateTextWithConfig({
        config: opts.config,
        filePath: opts.filePath,
        content: body,
        message: opts.message,
        githubToken: opts.githubToken,
        sha: remote?.sha,
        fetchImpl: opts.fetchImpl,
      })
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const conflict = /409|422|does not match|is at|but expected/i.test(msg)
      if (!conflict || attempt === 3) throw err
    }
  }
}
