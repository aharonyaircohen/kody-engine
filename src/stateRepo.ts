import path from "node:path"
import { gh } from "./issue.js"

export interface StateRepoState {
  repo: string
  path: string
}

export interface StateRepoConfig {
  github?: {
    owner: string
    repo: string
  }
  state?: StateRepoState
}

export interface ParsedStateRepo {
  owner: string
  repo: string
  basePath: string
}

export interface LoadedStateFile {
  path: string
  content: string
  sha: string
}

interface ContentsFile {
  type?: string
  encoding?: string
  content?: string
  sha?: string
  path?: string
}

interface ContentsEntry {
  name?: string
  path?: string
  type?: string
}

function is404(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /HTTP 404/i.test(msg) || /Not Found/i.test(msg)
}

export function parseStateRepoSlug(slug: string, field = "stateRepo"): { owner: string; repo: string } {
  const value = slug.trim()
  let repoPath = value
  if (/^https?:\/\//i.test(value)) {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new Error(`kody.config.json: ${field} must be a GitHub repository URL`)
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
      throw new Error(`kody.config.json: ${field} must be a https://github.com repository URL`)
    }
    repoPath = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")
  }
  const parts = repoPath.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`kody.config.json: ${field} must be a https://github.com/owner/repo URL`)
  }

  for (const part of parts) {
    if (!/^[A-Za-z0-9_.-]+$/.test(part)) {
      throw new Error(`kody.config.json: ${field} contains invalid repo part "${part}"`)
    }
  }

  return { owner: parts[0], repo: parts[1] }
}

export function normalizeStatePath(raw: string, field = "statePath"): string {
  const value = raw.trim().replace(/^\/+|\/+$/g, "")
  if (!value) throw new Error(`kody.config.json: ${field} must not be empty`)

  const parts = value.split("/")
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new Error(`kody.config.json: ${field} must be a relative path without "." or ".."`)
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(part)) {
      throw new Error(`kody.config.json: ${field} contains invalid path part "${part}"`)
    }
  }

  return parts.join("/")
}

export function resolveStateRepoConfig(config: StateRepoConfig): StateRepoState {
  if (config.state?.repo && config.state?.path) {
    parseStateRepoSlug(config.state.repo)
    return {
      repo: config.state.repo,
      path: normalizeStatePath(config.state.path),
    }
  }

  if (config.github?.owner && config.github?.repo) {
    return {
      repo: `${config.github.owner}/kody-state`,
      path: normalizeStatePath(config.github.repo),
    }
  }

  throw new Error("stateRepo: config.state or config.github owner/repo is required")
}

export function parseStateRepo(config: StateRepoConfig): ParsedStateRepo {
  const state = resolveStateRepoConfig(config)
  const parsed = parseStateRepoSlug(state.repo)
  return { ...parsed, basePath: state.path }
}

export function stateRepoPath(config: StateRepoConfig, filePath: string): string {
  const state = resolveStateRepoConfig(config)
  const relative = normalizeStatePath(filePath, "state file path")
  return path.posix.join(state.path, relative)
}

function apiPath(config: StateRepoConfig, targetPath: string): string {
  const parsed = parseStateRepo(config)
  return `/repos/${parsed.owner}/${parsed.repo}/contents/${targetPath}`
}

export function readStateText(
  config: StateRepoConfig,
  cwd: string | undefined,
  filePath: string,
): LoadedStateFile | null {
  const targetPath = stateRepoPath(config, filePath)
  let raw = ""
  try {
    raw = gh(["api", apiPath(config, targetPath)], { cwd })
  } catch (err) {
    if (is404(err)) return null
    throw err
  }

  let parsed: ContentsFile
  try {
    parsed = JSON.parse(raw) as ContentsFile
  } catch {
    throw new Error(`stateRepo: ${targetPath} did not return JSON`)
  }
  if (parsed.type !== "file" || parsed.encoding !== "base64" || typeof parsed.content !== "string") {
    throw new Error(`stateRepo: ${targetPath} is not a base64 file`)
  }
  if (typeof parsed.sha !== "string") {
    throw new Error(`stateRepo: ${targetPath} response missing sha`)
  }

  return {
    path: targetPath,
    content: Buffer.from(parsed.content, "base64").toString("utf-8"),
    sha: parsed.sha,
  }
}

export function writeStateText(
  config: StateRepoConfig,
  cwd: string | undefined,
  filePath: string,
  content: string,
  message: string,
  sha?: string,
): void {
  const targetPath = stateRepoPath(config, filePath)
  const payload: Record<string, unknown> = {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
  }
  if (sha) payload.sha = sha

  gh(["api", "--method", "PUT", apiPath(config, targetPath), "--input", "-"], {
    cwd,
    input: JSON.stringify(payload),
  })
}

export function upsertStateText(
  config: StateRepoConfig,
  cwd: string | undefined,
  filePath: string,
  content: string,
  message: string,
): void {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const current = readStateText(config, cwd, filePath)
    try {
      writeStateText(config, cwd, filePath, content, message, current?.sha)
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const conflict = /HTTP 409/i.test(msg) || /HTTP 422/i.test(msg) || /does not match|is at|but expected/i.test(msg)
      if (!conflict || attempt === 3) throw err
    }
  }
}

export function appendStateLine(
  config: StateRepoConfig,
  cwd: string | undefined,
  filePath: string,
  line: string,
  message: string,
): void {
  const prior = readStateText(config, cwd, filePath)
  const next = `${prior?.content ?? ""}${line.endsWith("\n") ? line : `${line}\n`}`
  writeStateText(config, cwd, filePath, next, message, prior?.sha)
}

export function listStateDirectory(config: StateRepoConfig, cwd: string | undefined, dirPath: string): ContentsEntry[] {
  const targetPath = stateRepoPath(config, dirPath)
  let raw = ""
  try {
    raw = gh(["api", apiPath(config, targetPath)], { cwd })
  } catch (err) {
    if (is404(err)) return []
    throw err
  }

  const parsed = JSON.parse(raw) as unknown
  return Array.isArray(parsed) ? (parsed as ContentsEntry[]) : []
}
