/**
 * Preflight for the `memorize` watch executable.
 *
 * Sets up a dedicated branch off the default branch for vault edits, gathers
 * recently merged PRs since the vault was last touched, and indexes the
 * existing `.kody/vault/` so the agent can decide which pages to update.
 *
 * Design:
 *   - Pure preflight. The agent does the synthesis (Edit/Write under .kody/vault/).
 *   - Stateless: "since" is derived from the vault's most recent updated frontmatter
 *     timestamp, falling back to a configurable lookback window. No external
 *     state file. Survives reset / fresh checkout.
 *   - Bounded: at most MAX_RECENT_PRS PR summaries injected into the prompt.
 *     If a tick falls behind, the next tick picks up the rest.
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"
import { gh } from "../issue.js"

const VAULT_DIR_RELATIVE = ".kody/vault"
const DEFAULT_LOOKBACK_HOURS = 36
const MAX_RECENT_PRS = 25
const MAX_VAULT_INDEX_ENTRIES = 200
const PR_BODY_TRUNC = 2_000

interface RecentPr {
  number: number
  title: string
  url: string
  mergedAt: string
  body: string
}

export const memorizeFlow: PreflightScript = async (ctx) => {
  const vaultAbs = path.join(ctx.cwd, VAULT_DIR_RELATIVE)

  ensureBranch(ctx, vaultAbs)
  if (ctx.skipAgent) return

  const sinceIso = computeSinceIso(vaultAbs)
  ctx.data.vaultSinceIso = sinceIso
  ctx.data.vaultUpdatedIso = new Date().toISOString().slice(0, 10)
  ctx.data.vaultDir = VAULT_DIR_RELATIVE

  const recent = fetchRecentPrs(ctx.cwd, sinceIso)
  ctx.data.recentPrs = formatRecentPrs(recent)
  ctx.data.recentPrCount = recent.length

  if (!fs.existsSync(vaultAbs)) {
    fs.mkdirSync(vaultAbs, { recursive: true })
  }
  ctx.data.vaultIndex = formatVaultIndex(vaultAbs)

  if (recent.length === 0) {
    process.stdout.write(`[kody memorize] no merged PRs since ${sinceIso}; agent may emit no changes\n`)
  } else {
    process.stdout.write(`[kody memorize] ${recent.length} merged PR(s) since ${sinceIso} → branch ${ctx.data.branch}\n`)
  }
}

function ensureBranch(ctx: Parameters<PreflightScript>[0], vaultAbs: string): void {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  // Flat namespace (no `/`) — many consumer repos already have a bare `kody`
  // branch from kody-bootstrap, which makes any `kody/<sub>` push fail with a
  // git "directory/file conflict" against `refs/heads/kody`.
  const branch = `kody-memorize-${stamp}`
  const defaultBranch = ctx.config.git.defaultBranch

  try {
    git(["fetch", "origin", defaultBranch], ctx.cwd)
  } catch {
    /* best effort */
  }

  // Start from origin/<default> when possible to avoid drift from the runner's
  // checkout state. If the day's branch already exists (a re-tick within the
  // same UTC day), check it out and reset onto origin/<default> to avoid
  // re-doing work in a stale tree.
  try {
    git(["rev-parse", "--verify", `origin/${branch}`], ctx.cwd)
    git(["checkout", "-B", branch, `origin/${branch}`], ctx.cwd)
  } catch {
    try {
      git(["checkout", "-B", branch, `origin/${defaultBranch}`], ctx.cwd)
    } catch {
      git(["checkout", "-B", branch], ctx.cwd)
    }
  }

  ctx.data.branch = branch

  if (!fs.existsSync(vaultAbs)) {
    fs.mkdirSync(vaultAbs, { recursive: true })
  }
}

function computeSinceIso(vaultAbs: string): string {
  const fallback = new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()
  if (!fs.existsSync(vaultAbs)) return fallback

  let latest = ""
  walkMd(vaultAbs, (file) => {
    let raw: string
    try {
      raw = fs.readFileSync(file, "utf-8")
    } catch {
      return
    }
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!m) return
    const updated = m[1]?.match(/^updated:\s*([0-9T:.+\-Z]+)/m)
    if (!updated) return
    const ts = new Date(updated[1]!.trim()).toISOString()
    if (ts > latest) latest = ts
  })
  return latest || fallback
}

function fetchRecentPrs(cwd: string, sinceIso: string): RecentPr[] {
  let raw: string
  try {
    raw = gh(
      [
        "pr",
        "list",
        "--state",
        "merged",
        "--limit",
        String(MAX_RECENT_PRS * 2),
        "--json",
        "number,title,url,mergedAt,body",
      ],
      { cwd },
    )
  } catch {
    return []
  }
  let arr: Array<{ number?: number; title?: string; url?: string; mergedAt?: string; body?: string }>
  try {
    arr = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []

  const since = Date.parse(sinceIso)
  const filtered: RecentPr[] = []
  for (const p of arr) {
    if (typeof p.number !== "number") continue
    const merged = p.mergedAt ? Date.parse(p.mergedAt) : NaN
    if (!Number.isFinite(merged) || merged <= since) continue
    filtered.push({
      number: p.number,
      title: p.title ?? "(no title)",
      url: p.url ?? "",
      mergedAt: p.mergedAt ?? "",
      body: (p.body ?? "").slice(0, PR_BODY_TRUNC),
    })
    if (filtered.length >= MAX_RECENT_PRS) break
  }
  return filtered
}

function formatRecentPrs(prs: RecentPr[]): string {
  if (prs.length === 0) return "_(no merged PRs since the last memorize tick)_"
  const lines: string[] = []
  for (const p of prs) {
    lines.push(`### PR #${p.number} — ${p.title}`)
    if (p.url) lines.push(p.url)
    lines.push(`Merged: ${p.mergedAt}`)
    lines.push("")
    if (p.body.trim()) {
      lines.push(p.body.trim())
    } else {
      lines.push("_(no PR body)_")
    }
    lines.push("")
  }
  return lines.join("\n")
}

function formatVaultIndex(vaultAbs: string): string {
  const entries: string[] = []
  walkMd(vaultAbs, (file) => {
    if (entries.length >= MAX_VAULT_INDEX_ENTRIES) return
    const rel = path.relative(vaultAbs, file)
    let title = rel
    try {
      const raw = fs.readFileSync(file, "utf-8")
      const m = raw.match(/^---\s*\n([\s\S]*?)\n---/)
      const titleMatch = m?.[1]?.match(/^title:\s*(.+)$/m)
      if (titleMatch) title = `${titleMatch[1]!.trim()} (${rel})`
    } catch {
      /* ignore */
    }
    entries.push(`- ${title}`)
  })
  if (entries.length === 0) return "_(vault is empty)_"
  return entries.join("\n")
}

function walkMd(root: string, visit: (file: string) => void): void {
  if (!fs.existsSync(root)) return
  let stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (name.startsWith(".")) continue
      const full = path.join(dir, name)
      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        stack.push(full)
        continue
      }
      if (stat.isFile() && full.endsWith(".md")) visit(full)
    }
  }
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    timeout: 30_000,
    cwd,
    env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}
