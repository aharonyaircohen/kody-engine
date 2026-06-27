import { execFileSync } from "node:child_process"
import { gh, truncate } from "./issue.js"
import { pushWithRetry } from "./pushWithRetry.js"

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
    const out = gh(["pr", "view", String(prNumber), "--json", "mergeable,mergeStateStatus"], {
      cwd,
      preferRepoToken: true,
    })
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
      { cwd, preferRepoToken: true },
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

// Two real phrasings: GraphQL "A pull request already exists for owner:branch"
// and gh CLI "a pull request for branch 'X' already exists".
const ALREADY_EXISTS_RE = /pull request .*already exists|already exists for/i

/**
 * True when `gh pr create` failed because GitHub believes an open PR already
 * exists for the head branch. Exported for unit testing the matcher.
 */
export function isAlreadyExistsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return ALREADY_EXISTS_RE.test(msg)
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

/**
 * Update an existing PR's body and return an "updated" result.
 *
 * Body only — never rewrite the title. Past regenerations stacked "[WIP] #N:"
 * prefixes on each fix/fix-ci/resolve run until the title was unreadable.
 *
 * REST PATCH instead of `gh pr edit`: gh's edit path uses GraphQL which
 * requires `read:org` scope on KODY_TOKEN. REST PATCH works with plain `repo`
 * scope (matching what release/deploy.sh already does).
 */
function updateExistingPr(
  existing: { number: number; url: string },
  body: string,
  draft: boolean,
  cwd?: string,
): PrResult {
  const stripped = existing.url.replace(/^https:\/\/github\.com\//, "")
  const [owner, repo] = stripped.split("/")
  try {
    gh(["api", "--method", "PATCH", `repos/${owner}/${repo}/pulls/${existing.number}`, "-f", `body=${body}`], {
      cwd,
      preferRepoToken: true,
    })
  } catch (err) {
    // Surface the failure — the ensurePr script wraps this in try/catch and
    // reports it via ctx.output.reason. Swallowing it once masked a successful
    // update over a real downstream failure.
    throw new Error(`gh api PATCH #${existing.number} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { url: existing.url, number: existing.number, draft, action: "updated" }
}

/** Run `gh pr create` and parse the PR number out of the returned URL. */
function createPr(branch: string, base: string, title: string, body: string, draft: boolean, cwd?: string): PrResult {
  const args = ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body-file", "-"]
  if (draft) args.push("--draft")
  // Goal-task PRs (base = goal-<id>) are merged into the goal branch by
  // goal-manager on a subsequent tick — we don't enable GitHub auto-merge here.
  const url = gh(args, { input: body, cwd, preferRepoToken: true }).trim()
  const match = url.match(/\/pull\/(\d+)$/)
  const number = match ? parseInt(match[1], 10) : 0
  return { url, number, draft, action: "created" }
}

/**
 * Recover from a "a pull request already exists" failure on `gh pr create`.
 *
 * GitHub's create mutation can report an open PR for the head branch even when
 * `gh pr list --head` — and the REST pulls API in *any* state — surface
 * nothing: an indexing inconsistency that leaves the branch ref associated
 * with a PR no read API will return. The work is already committed and pushed,
 * so nothing on our side is wrong to fix; the run just can't open its PR.
 *
 * Two causes, handled in order:
 *   1. List-vs-create race — a real open PR appeared between findExistingPr and
 *      the create. Re-check; if found, reuse it (update its body).
 *   2. True phantom — no listable PR. The remote branch ref is orphaned. Delete
 *      it (clearing the phantom association), re-push the current HEAD to the
 *      *same* name (keeps the `<issue>-<slug>` convention so the next run's
 *      findExistingPr still matches → idempotent), then retry create once.
 *      A second failure is real and propagates.
 */
function recoverFromExistingPr(
  branch: string,
  base: string,
  title: string,
  body: string,
  draft: boolean,
  cwd?: string,
): PrResult {
  const raced = findExistingPr(branch, cwd)
  if (raced) return updateExistingPr(raced, body, draft, cwd)

  try {
    git(["push", "origin", "--delete", branch], cwd)
  } catch {
    // Ref may already be gone — the re-push below recreates it regardless.
  }
  const push = pushWithRetry({ cwd, branch, setUpstream: true })
  if (!push.ok) {
    throw new Error(`re-push after deleting orphaned branch '${branch}' failed: ${push.reason}`)
  }
  return createPr(branch, base, title, body, draft, cwd)
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
    return updateExistingPr(existing, body, opts.draft, opts.cwd)
  }

  const base = opts.baseBranch && opts.baseBranch.length > 0 ? opts.baseBranch : opts.defaultBranch
  try {
    return createPr(opts.branch, base, title, body, opts.draft, opts.cwd)
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err
    return recoverFromExistingPr(opts.branch, base, title, body, opts.draft, opts.cwd)
  }
}
