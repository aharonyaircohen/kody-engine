/**
 * Hydrate Kody-authored runtime assets from the configured state repo into a
 * temporary local `.kody` cache for existing file-based engine loaders.
 */

import { execFileSync } from "node:child_process"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { STATE_BRANCH } from "./stateBranch.js"
import { type ParsedStateRepo, parseStateRepo, type StateRepoConfig } from "./stateRepo.js"

const DIR_MAPPINGS: Array<{ stateDir: string; localDir: string }> = [
  { stateDir: "executables", localDir: path.join(".kody", "executables") },
  { stateDir: "capabilities", localDir: path.join(".kody", "capabilities") },
  { stateDir: "agents", localDir: path.join(".kody", "agents") },
  { stateDir: "context", localDir: path.join(".kody", "context") },
  { stateDir: "memory", localDir: path.join(".kody", "memory") },
]

const FILE_MAPPINGS: Array<{ statePath: string; localPath: string }> = [
  { statePath: "instructions.md", localPath: path.join(".kody", "instructions.md") },
  { statePath: "variables.json", localPath: path.join(".kody", "variables.json") },
  { statePath: "secrets.enc", localPath: path.join(".kody", "secrets.enc") },
]

const CACHE_ENV = "KODY_STATE_REPO_CACHE"
const TEST_FETCH_ENV = "KODY_STATE_WORKSPACE_FETCH_FOR_TESTS"
const hydratedWorkspaces = new Set<string>()

function writeLocalFile(cwd: string, relativePath: string, content: string): void {
  const fullPath = path.join(cwd, relativePath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content)
}

function copyPath(source: string, target: string): void {
  const st = fs.lstatSync(source)
  fs.rmSync(target, { recursive: true, force: true })
  if (st.isSymbolicLink()) return
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(source, target, { recursive: true, force: true })
}

function overlayDirectoryChildren(cwd: string, sourceDir: string, localDir: string): void {
  if (!fs.existsSync(sourceDir)) return

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name)
    const target = path.join(cwd, localDir, entry.name)
    copyPath(source, target)
  }
}

export function hydrateStateWorkspace(config: StateRepoConfig, cwd: string): void {
  if (process.env.VITEST && process.env[TEST_FETCH_ENV] !== "1") return

  const parsed = parseStateRepo(config)
  const hydrateKey = `${path.resolve(cwd)}|${parsed.owner}/${parsed.repo}|${parsed.basePath}|${STATE_BRANCH}`
  if (hydratedWorkspaces.has(hydrateKey)) return

  const snapshotRoot = fetchStateSnapshot(parsed)

  for (const mapping of DIR_MAPPINGS) {
    overlayDirectoryChildren(cwd, path.join(snapshotRoot, mapping.stateDir), mapping.localDir)
  }

  for (const mapping of FILE_MAPPINGS) {
    const source = path.join(snapshotRoot, mapping.statePath)
    if (fs.existsSync(source) && !fs.lstatSync(source).isSymbolicLink() && fs.statSync(source).isFile()) {
      writeLocalFile(cwd, mapping.localPath, fs.readFileSync(source, "utf-8"))
    }
  }

  hydratedWorkspaces.add(hydrateKey)
}

export function resetStateWorkspaceHydrationCacheForTests(): void {
  hydratedWorkspaces.clear()
}

function fetchStateSnapshot(parsed: ParsedStateRepo): string {
  const cacheDir = path.join(cacheRoot(), cacheKey(parsed))
  const url = `https://github.com/${parsed.owner}/${parsed.repo}.git`

  try {
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true })
    if (!fs.existsSync(path.join(cacheDir, ".git"))) {
      fs.rmSync(cacheDir, { recursive: true, force: true })
      runGit(["clone", "--no-checkout", "--filter=blob:none", url, cacheDir])
    }

    runGit(["-C", cacheDir, "remote", "set-url", "origin", url])
    runGit(["-C", cacheDir, "fetch", "--depth=1", "origin", STATE_BRANCH])
    runGit(["-C", cacheDir, "sparse-checkout", "init", "--cone"])
    runGit(["-C", cacheDir, "sparse-checkout", "set", parsed.basePath])
    runGit(["-C", cacheDir, "checkout", "--force", "--detach", "FETCH_HEAD"])
    runGit(["-C", cacheDir, "clean", "-fdx"])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `stateWorkspace: failed to fetch ${parsed.owner}/${parsed.repo}:${parsed.basePath}@${STATE_BRANCH}: ${msg}`,
    )
  }

  return path.join(cacheDir, parsed.basePath)
}

function cacheRoot(): string {
  return process.env[CACHE_ENV]?.trim() || path.join(os.homedir(), ".cache", "kody", "state-repo")
}

function cacheKey(parsed: ParsedStateRepo): string {
  return crypto
    .createHash("sha256")
    .update(`${parsed.owner}/${parsed.repo}#${STATE_BRANCH}#${parsed.basePath}`)
    .digest("hex")
    .slice(0, 24)
}

function runGit(args: string[]): void {
  try {
    execFileSync("git", args, {
      encoding: "utf-8",
      env: githubAuthEnv(),
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 120_000,
    })
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr
    const detail = Buffer.isBuffer(stderr)
      ? stderr.toString("utf-8").trim()
      : typeof stderr === "string"
        ? stderr.trim()
        : ""
    throw new Error(detail || `git ${args[0] ?? "command"} failed`)
  }
}

function githubAuthEnv(): NodeJS.ProcessEnv {
  const token = githubToken()
  if (!token) return process.env
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64")
  const existingCount = /^\d+$/.test(process.env.GIT_CONFIG_COUNT ?? "") ? Number(process.env.GIT_CONFIG_COUNT) : 0
  return {
    ...process.env,
    GIT_CONFIG_COUNT: String(existingCount + 1),
    [`GIT_CONFIG_KEY_${existingCount}`]: "http.https://github.com/.extraheader",
    [`GIT_CONFIG_VALUE_${existingCount}`]: `AUTHORIZATION: basic ${encoded}`,
  }
}

function githubToken(): string | undefined {
  return (
    process.env.KODY_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_PAT?.trim() ||
    undefined
  )
}
