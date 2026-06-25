/**
 * Preflight: surface the project's state-repo memory markdown wiki into the
 * agent's prompt as `{{memoryContext}}`. Engine runs hydrate it into the local
 * `.kody/memory/` compatibility cache before this loader runs.
 *
 * Strategy:
 *   - Walk the memory dir, take at most MAX_PAGES pages.
 *   - If the agentAction has an issue/PR title in ctx.data, score pages by
 *     simple keyword overlap with that title to favor relevance.
 *   - Otherwise return the most-recently-updated pages (by `updated:`
 *     frontmatter, falling back to mtime).
 *   - Cap the total block at TOTAL_MAX_BYTES to protect the prompt budget.
 *
 * Tolerant: missing memory dir, empty dir, or any read error returns "" — the
 * memory is advisory context, not required input.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../agent-actions/types.js"

const MEMORY_DIR_RELATIVE = ".kody/memory"
const MAX_PAGES = 8
const PER_PAGE_MAX_BYTES = 4_000
const TOTAL_MAX_BYTES = 24_000
const TRUNCATED_SUFFIX = "\n\n… (truncated)"

interface MemoryPage {
  relPath: string
  title: string
  updated: string
  content: string
  mtime: number
}

export const loadMemoryContext: PreflightScript = async (ctx) => {
  // Phase 5 fast path: container already loaded memory pages. Detect by
  // "key present" so empty-memory ("") is honoured too.
  if (typeof ctx.data.memoryContext === "string") return

  const memoryAbs = path.join(ctx.cwd, MEMORY_DIR_RELATIVE)
  if (!fs.existsSync(memoryAbs)) {
    ctx.data.memoryContext = ""
    return
  }

  let pages: MemoryPage[] = []
  try {
    pages = collectPages(memoryAbs)
  } catch {
    ctx.data.memoryContext = ""
    return
  }
  if (pages.length === 0) {
    ctx.data.memoryContext = ""
    return
  }

  const queryTerms = extractQueryTerms(ctx)
  const ranked = queryTerms.length > 0 ? scorePages(pages, queryTerms) : sortByRecency(pages)

  // Always promote INDEX.md to the top of the prompt. It is the cheap
  // table of contents and exists specifically so the agent learns what
  // memory is available without opening every file. Without explicit
  // promotion, a high-relevance lesson can outrank INDEX.md and the
  // agent never sees the full catalog.
  const indexPage = pages.find((p) => p.relPath === "INDEX.md")
  const withoutIndex = ranked.filter((p) => p.relPath !== "INDEX.md")
  const ordered = indexPage ? [indexPage, ...withoutIndex] : withoutIndex
  const top = ordered.slice(0, MAX_PAGES)

  ctx.data.memoryContext = formatBlock(top)
}

function collectPages(memoryAbs: string): MemoryPage[] {
  const out: MemoryPage[] = []
  walkMd(memoryAbs, (file) => {
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      return
    }
    let raw: string
    try {
      raw = fs.readFileSync(file, "utf-8")
    } catch {
      return
    }
    const fm = raw.match(/^---\s*\n([\s\S]*?)\n---/)
    const title = fm?.[1]?.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? path.basename(file, ".md")
    const updated = fm?.[1]?.match(/^updated:\s*([0-9T:.+\-Z]+)/m)?.[1]?.trim() ?? ""
    out.push({
      relPath: path.relative(memoryAbs, file),
      title,
      updated,
      content: raw.length > PER_PAGE_MAX_BYTES ? raw.slice(0, PER_PAGE_MAX_BYTES) + TRUNCATED_SUFFIX : raw,
      mtime: stat.mtimeMs,
    })
  })
  return out
}

function extractQueryTerms(ctx: Parameters<PreflightScript>[0]): string[] {
  const terms: string[] = []
  const issue = ctx.data.issue as { title?: string; body?: string } | undefined
  const pr = ctx.data.pr as { title?: string; body?: string } | undefined
  if (issue?.title) terms.push(...tokenize(issue.title))
  if (pr?.title) terms.push(...tokenize(pr.title))
  return Array.from(new Set(terms)).slice(0, 20)
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3)
}

function scorePages(pages: MemoryPage[], terms: string[]): MemoryPage[] {
  return pages
    .map((p) => {
      const haystack = `${p.title} ${p.content}`.toLowerCase()
      let score = 0
      for (const t of terms) {
        if (haystack.includes(t)) score++
      }
      return { p, score }
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.p.mtime - a.p.mtime
    })
    .map((x) => x.p)
}

function sortByRecency(pages: MemoryPage[]): MemoryPage[] {
  return [...pages].sort((a, b) => {
    if (a.updated && b.updated && a.updated !== b.updated) {
      return b.updated.localeCompare(a.updated)
    }
    return b.mtime - a.mtime
  })
}

function formatBlock(pages: MemoryPage[]): string {
  if (pages.length === 0) return ""
  const lines: string[] = [
    "# Project memory (state repo `memory/`)",
    "",
    "Pages from prior memorize ticks. Treat as advisory context — confirm against the codebase before acting.",
    "",
  ]
  let total = 0
  for (const p of pages) {
    const block = [`## ${p.title} — \`${p.relPath}\``, "", p.content].join("\n")
    if (total + block.length > TOTAL_MAX_BYTES) {
      lines.push("_… (further pages truncated to fit budget)_")
      break
    }
    lines.push(block)
    lines.push("")
    total += block.length
  }
  return lines.join("\n")
}

function walkMd(root: string, visit: (file: string) => void): void {
  const stack: string[] = [root]
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
