import { gh, truncate } from "./issue.js"

export interface PrResult {
  url: string
  number: number
  draft: boolean
  action: "created" | "updated"
}

/**
 * GitHub's authoritative answer to "can this PR be merged?" — single
 * source of truth, no local-vs-remote drift.
 *
 * Surfaced separately from the local `mergeBase` action so callers can:
 *   1. Ask GitHub first ("is there a real conflict to resolve?")
 *   2. Only attempt a local merge when GitHub confirms a conflict.
 *
 * Mapping:
 *   - `MERGEABLE`     — gh: mergeable=MERGEABLE, no conflicts; safe to merge.
 *   - `CONFLICTING`   — gh: mergeable=CONFLICTING; resolve required.
 *   - `BLOCKED`       — gh: mergeable=MERGEABLE but mergeStateStatus=BLOCKED
 *                       (failing checks, missing reviews, etc.) — no resolve work.
 *   - `UNKNOWN`       — gh hasn't computed yet (race); caller should retry.
 *   - `ERROR`         — gh call failed; caller decides whether to retry/bail.
 *
 * Replaces ad-hoc `gh pr view ... --json mergeable,mergeStateStatus` calls
 * scattered across syncFlow / resolveFlow / mergeReadyTaskPRs / etc.
 */
export type PrMergeStatus = "MERGEABLE" | "CONFLICTING" | "BLOCKED" | "UNKNOWN" | "ERROR"

export interface PrMergeInfo {
  status: PrMergeStatus
  /** Raw `mergeable` value from gh (`MERGEABLE` | `CONFLICTING` | `UNKNOWN`). */
  mergeable: string
  /** Raw `mergeStateStatus` from gh (`CLEAN` | `DIRTY` | `BLOCKED` | `BEHIND` | `UNSTABLE` | `UNKNOWN`). */
  mergeStateStatus: string
}

export function prMergeStatus(prNumber: number, cwd?: string): PrMergeInfo {
  try {
    const out = gh(
      ["pr", "view", String(prNumber), "--json", "mergeable,mergeStateStatus"],
      { cwd },
    )
    const parsed = JSON.parse(out) as { mergeable?: string; mergeStateStatus?: string }
    const mergeable = parsed.mergeable ?? "UNKNOWN"
    const mergeStateStatus = parsed.mergeStateStatus ?? "UNKNOWN"
    return { status: classifyMergeStatus(mergeable, mergeStateStatus), mergeable, mergeStateStatus }
  } catch {
    return { status: "ERROR", mergeable: "", mergeStateStatus: "" }
  }
}

function classifyMergeStatus(mergeable: string, mergeStateStatus: string): PrMergeStatus {
  if (mergeable === "CONFLICTING") return "CONFLICTING"
  if (mergeable === "UNKNOWN") return "UNKNOWN"
  if (mergeable === "MERGEABLE") {
    if (mergeStateStatus === "CLEAN") return "MERGEABLE"
    if (mergeStateStatus === "DIRTY") return "CONFLICTING"
    // BLOCKED, BEHIND, UNSTABLE, UNKNOWN — mergeable in principle but
    // gated by external policy. Resolve has nothing to do; sync/CI
    // belongs in a different flow.
    return "BLOCKED"
  }
  return "UNKNOWN"
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
  /**
   * Optional PR base override (e.g. `goal-<id>` so a task PR targets the
   * shared goal branch instead of the repo default). Falls through to
   * `defaultBranch` when absent. Goal-tick is the only intended caller; the
   * runFlow allowlist enforces that.
   */
  baseBranch?: string
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
    //
    // Use REST PATCH instead of `gh pr edit`: gh's edit path uses GraphQL
    // which requires `read:org` scope on KODY_TOKEN. REST PATCH works with
    // plain `repo` scope (matching what release/deploy.sh already does).
    const stripped = existing.url.replace(/^https:\/\/github\.com\//, "")
    const [owner, repo] = stripped.split("/")
    try {
      gh(["api", "--method", "PATCH", `repos/${owner}/${repo}/pulls/${existing.number}`, "-f", `body=${body}`], {
        cwd: opts.cwd,
      })
    } catch (err) {
      // Let the caller decide how to handle this. The ensurePr script
      // already wraps doEnsurePr in try/catch and surfaces the error as
      // ctx.output.reason. Previously this was swallowed to stderr and
      // masked as a successful update, which buried the real cause of
      // downstream failures.
      throw new Error(`gh api PATCH #${existing.number} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { url: existing.url, number: existing.number, draft: opts.draft, action: "updated" }
  }

  const base = opts.baseBranch && opts.baseBranch.length > 0 ? opts.baseBranch : opts.defaultBranch
  const args = [
    "pr",
    "create",
    "--head",
    opts.branch,
    "--base",
    base,
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

  // Goal-task PRs (base = goal-<id>) are merged into the goal branch by
  // goal-tick on a subsequent tick — we don't enable GitHub auto-merge here.
  // See src/executables/goal-tick/tick.sh.

  return { url, number, draft: opts.draft, action: "created" }
}
