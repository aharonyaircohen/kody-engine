import { gh, truncate } from "./issue.js"

export interface PrResult {
  url: string
  number: number
  draft: boolean
  action: "created" | "updated"
}

export interface EnsurePrOptions {
  branch: string
  defaultBranch: string
  issueNumber: number
  issueTitle: string
  draft: boolean
  failureReason?: string
  changedFiles: string[]
  /** Agent-supplied PR_SUMMARY (multi-line, what the change does and why). */
  agentSummary?: string
  cwd?: string
}

const TITLE_MAX = 72

/**
 * Strip any leading `[WIP] #N: ` / `#N: ` prefixes that an earlier run may
 * have already baked into the title. Without this the prefix stacks on every
 * fix/fix-ci/resolve run (e.g. "[WIP] #42: [WIP] #42: [WIP] #42: ...").
 */
export function stripTitlePrefixes(raw: string): string {
  let s = raw.trim()
  // repeatedly peel `[WIP] #N:` or `#N:` until no match remains
  while (true) {
    const next = s.replace(/^(\[WIP\]\s*)?#\d+:\s*/, "")
    if (next === s) break
    s = next
  }
  return s
}

export function buildPrTitle(issueNumber: number, issueTitle: string, draft: boolean): string {
  const prefix = draft ? "[WIP] " : ""
  const clean = stripTitlePrefixes(issueTitle)
  const base = `${prefix}#${issueNumber}: ${clean}`
  if (base.length <= TITLE_MAX) return base
  return `${base.slice(0, TITLE_MAX - 1)}…`
}

export function buildPrBody(opts: EnsurePrOptions): string {
  const lines: string[] = []

  if (opts.draft && opts.failureReason) {
    const headline = firstLine(opts.failureReason)
    lines.push(`> ⚠️ Draft: ${headline}`)
    lines.push(`> The failures below may be **pre-existing in the repo** — verify before treating as PR-blocking.`)
    lines.push("")
  }

  lines.push("## Summary")
  lines.push("")
  if (opts.agentSummary?.trim()) {
    lines.push(opts.agentSummary.trim())
  } else {
    lines.push(`Implementation of issue #${opts.issueNumber} — ${opts.issueTitle}`)
    lines.push("")
    lines.push("_(agent did not supply PR_SUMMARY)_")
  }
  lines.push("")

  if (opts.changedFiles.length > 0) {
    lines.push("## Changes")
    lines.push("")
    for (const f of opts.changedFiles.slice(0, 50)) lines.push(`- \`${f}\``)
    if (opts.changedFiles.length > 50) lines.push(`- … and ${opts.changedFiles.length - 50} more`)
    lines.push("")
  }

  lines.push(`Closes #${opts.issueNumber}`)
  lines.push("")

  if (opts.draft && opts.failureReason) {
    lines.push("<details>")
    lines.push("<summary>Verify output (click to expand)</summary>")
    lines.push("")
    lines.push("```")
    lines.push(truncate(opts.failureReason, 6000))
    lines.push("```")
    lines.push("")
    lines.push("</details>")
    lines.push("")
  }

  lines.push("---")
  lines.push("_Opened by kody (single-session autonomous run)._ ")
  return lines.join("\n")
}

function firstLine(s: string): string {
  const trimmed = s.trim()
  const nl = trimmed.indexOf("\n")
  const head = nl === -1 ? trimmed : trimmed.slice(0, nl)
  return head.length > 200 ? `${head.slice(0, 197)}…` : head
}

export function findExistingPr(branch: string, cwd?: string): { number: number; url: string; body: string } | null {
  // Use `gh pr list --head` rather than `gh pr view <branch>`. `gh pr view`
  // treats a numeric arg as a PR number, so a branch literally named "1347"
  // (kody convention `<issue>-<slug>` minus the slug) is misread as PR #1347
  // and the existing PR is missed → the fall-through to `gh pr create` then
  // crashes with "a pull request for branch X already exists".
  try {
    const output = gh(
      ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,body", "--limit", "1"],
      { cwd },
    )
    const arr = JSON.parse(output)
    const first = Array.isArray(arr) ? arr[0] : null
    if (first && typeof first.number === "number" && typeof first.url === "string") {
      const body = typeof first.body === "string" ? first.body : ""
      return { number: first.number, url: first.url, body }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Recover the "source issue" a PR was opened against. We prefer the
 * `Closes #N` line from the PR's existing body (set by the first ensurePr
 * call from the `run` flow), falling back to the leading digits of the
 * branch name (kody branch convention: `<issueNumber>-<slug>`).
 *
 * Without this, review-fix / fix / resolve cycles overwrite the PR body
 * and emit `Closes #<PR own number>` — a self-reference that GitHub does
 * not honor for auto-close.
 */
export function recoverSourceIssueNumber(existingBody: string, branch: string, prNumber: number): number | null {
  const bodyMatch = existingBody.match(/\bCloses #(\d+)\b/i)
  if (bodyMatch) {
    const n = parseInt(bodyMatch[1], 10)
    if (n > 0 && n !== prNumber) return n
  }
  const branchMatch = branch.match(/^(\d+)-/)
  if (branchMatch) {
    const n = parseInt(branchMatch[1], 10)
    if (n > 0 && n !== prNumber) return n
  }
  return null
}

export function ensurePr(opts: EnsurePrOptions): PrResult {
  const existing = findExistingPr(opts.branch, opts.cwd)

  // When UPDATING an existing PR, the caller may pass `issueNumber = prNumber`
  // (fix/resolve/review-fix flows overwrite commentTargetNumber with the PR
  // number). Recover the original source issue from the PR's existing body or
  // branch name, so `Closes #N` keeps pointing at the real issue, not itself.
  const effectiveIssueNumber = existing
    ? (recoverSourceIssueNumber(existing.body, opts.branch, existing.number) ?? opts.issueNumber)
    : opts.issueNumber
  const effectiveOpts: EnsurePrOptions = { ...opts, issueNumber: effectiveIssueNumber }

  const title = buildPrTitle(effectiveOpts.issueNumber, effectiveOpts.issueTitle, effectiveOpts.draft)
  const body = buildPrBody(effectiveOpts)

  if (existing) {
    // Update body only — never rewrite the title on an existing PR. Past
    // regenerations stacked "[WIP] #N:" prefixes on each fix/fix-ci/resolve run
    // until the title was unreadable.
    try {
      gh(["pr", "edit", String(existing.number), "--body-file", "-"], { input: body, cwd: opts.cwd })
    } catch (err) {
      // Let the caller decide how to handle this. The ensurePr script
      // already wraps doEnsurePr in try/catch and surfaces the error as
      // ctx.output.reason. Previously this was swallowed to stderr and
      // masked as a successful update, which buried the real cause of
      // downstream failures.
      throw new Error(`gh pr edit #${existing.number} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { url: existing.url, number: existing.number, draft: opts.draft, action: "updated" }
  }

  const args = [
    "pr",
    "create",
    "--head",
    opts.branch,
    "--base",
    opts.defaultBranch,
    "--title",
    title,
    "--body-file",
    "-",
  ]
  if (opts.draft) args.push("--draft")

  const output = gh(args, { input: body, cwd: opts.cwd })
  const url = output.trim()
  const match = url.match(/\/pull\/(\d+)$/)
  const number = match ? parseInt(match[1], 10) : 0
  return { url, number, draft: opts.draft, action: "created" }
}
