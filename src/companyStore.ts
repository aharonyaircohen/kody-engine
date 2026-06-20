import { execFileSync } from "node:child_process"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export const DEFAULT_COMPANY_STORE = "aharonyaircohen/kody-company-store"
export const DEFAULT_COMPANY_STORE_REF = "stable"

const STORE_ENV = "KODY_COMPANY_STORE"
const REF_ENV = "KODY_COMPANY_STORE_REF"
const CACHE_ENV = "KODY_COMPANY_STORE_CACHE"

let memo: { key: string; root: string | null } | null = null

export function getCompanyStoreRoot(): string | null {
  const store = resolveCompanyStore()
  if (!store) return null

  const key = `${store.repo}#${store.ref}`
  if (memo?.key === key) return memo.root

  const root = fetchCompanyStore(store.repo, store.ref)
  memo = { key, root }
  return root
}

export function getCompanyStoreAssetRoot(kind: "duties" | "executables" | "staff"): string | null {
  const root = getCompanyStoreRoot()
  if (!root) return null
  return path.join(root, ".kody", kind)
}

export function resetCompanyStoreCacheForTests(): void {
  memo = null
}

function resolveCompanyStore(): { repo: string; ref: string } | null {
  const envStore = process.env[STORE_ENV]?.trim()

  // Unit tests must not hit GitHub unless a test opts in explicitly.
  if (!envStore && process.env.VITEST) return null

  const repo = envStore || DEFAULT_COMPANY_STORE
  if (repo === "0" || repo === "false" || repo === "off") return null

  const ref = process.env[REF_ENV]?.trim() || DEFAULT_COMPANY_STORE_REF
  if (!ref) return null

  return { repo, ref }
}

function fetchCompanyStore(repo: string, ref: string): string | null {
  const localRoot = localStoreRoot(repo)
  if (localRoot) return localRoot

  const url = repoToGitUrl(repo)
  const cacheDir = path.join(cacheRoot(), cacheKey(repo, ref))

  try {
    if (isGitHubShorthand(repo)) setupGithubGitAuth()

    fs.mkdirSync(path.dirname(cacheDir), { recursive: true })
    if (!fs.existsSync(path.join(cacheDir, ".git"))) {
      fs.rmSync(cacheDir, { recursive: true, force: true })
      runGit(["clone", "--no-checkout", "--filter=blob:none", url, cacheDir])
    }

    runGit(["-C", cacheDir, "remote", "set-url", "origin", url])
    runGit(["-C", cacheDir, "fetch", "--depth=1", "origin", ref])
    runGit(["-C", cacheDir, "checkout", "--detach", "FETCH_HEAD"])

    return cacheDir
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[company-store] failed to fetch ${repo}#${ref}: ${msg}\n`)
    return null
  }
}

function localStoreRoot(repo: string): string | null {
  if (!path.isAbsolute(repo) && !repo.startsWith(".")) return null
  const root = path.resolve(repo)
  if (!fs.existsSync(path.join(root, ".kody"))) return null
  return root
}

function repoToGitUrl(repo: string): string {
  if (/^(https?:|ssh:|git@|file:)/.test(repo)) return repo
  if (isGitHubShorthand(repo)) {
    return `https://github.com/${repo}.git`
  }
  return repo
}

function isGitHubShorthand(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
}

function cacheRoot(): string {
  return process.env[CACHE_ENV]?.trim() || path.join(os.homedir(), ".cache", "kody", "company-store")
}

function cacheKey(repo: string, ref: string): string {
  return crypto.createHash("sha256").update(`${repo}#${ref}`).digest("hex").slice(0, 24)
}

function runGit(args: string[]): void {
  execFileSync("git", args, { stdio: ["ignore", "ignore", "pipe"] })
}

function setupGithubGitAuth(): void {
  const token = process.env.KODY_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_PAT
  if (!token) return

  try {
    execFileSync("gh", ["auth", "setup-git", "--hostname", "github.com"], {
      env: { ...process.env, GH_TOKEN: token },
      stdio: ["ignore", "ignore", "pipe"],
    })
  } catch {
    // Public stores do not need auth, and private stores will fail clearly when
    // the subsequent git fetch cannot access the repo/ref.
  }
}
