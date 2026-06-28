import { execFileSync } from "node:child_process"

const API_TIMEOUT_MS = 30_000
const DEFAULT_RATE_LIMIT_RETRIES = 2
const DEFAULT_RATE_LIMIT_BASE_DELAY_MS = 1_000
const DEFAULT_RATE_LIMIT_MAX_WAIT_MS = 65 * 60 * 1_000

export interface IssueComment {
  body: string
  author: string
  createdAt: string
}

export interface IssueData {
  number: number
  title: string
  body: string
  comments: IssueComment[]
  url?: string
  isPullRequest?: boolean
  /**
   * GitHub labels applied to the issue. Used by the classifier's fast
   * path. Optional for backward compat with call sites that construct an
   * IssueData literal (e.g. tests) — getIssue always populates it.
   */
  labels?: string[]
}

interface GhOptions {
  input?: string
  cwd?: string
  preferRepoToken?: boolean
}

function ghToken(preferRepoToken = false): string | undefined {
  const githubToken = process.env.GITHUB_TOKEN?.trim()
  const kodyToken = process.env.KODY_TOKEN?.trim()
  const ghToken = process.env.GH_TOKEN?.trim()
  const ghPat = process.env.GH_PAT?.trim()

  return preferRepoToken ? githubToken || kodyToken || ghToken || ghPat : ghPat || ghToken || kodyToken || githubToken
}

export function gh(args: string[], options?: GhOptions): string {
  const token = ghToken(options?.preferRepoToken)
  const env: NodeJS.ProcessEnv = token ? { ...process.env, GH_TOKEN: token } : { ...process.env }
  const maxRetries = envInt("KODY_GH_RATE_LIMIT_MAX_RETRIES", DEFAULT_RATE_LIMIT_RETRIES)
  const maxWaitMs = envInt("KODY_GH_RATE_LIMIT_MAX_WAIT_MS", DEFAULT_RATE_LIMIT_MAX_WAIT_MS)

  for (let attempt = 0; ; attempt += 1) {
    try {
      return execFileSync("gh", args, {
        encoding: "utf-8",
        timeout: API_TIMEOUT_MS,
        cwd: options?.cwd,
        env,
        input: options?.input,
        stdio: options?.input ? ["pipe", "pipe", "pipe"] : ["inherit", "pipe", "pipe"],
      }).trim()
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= maxRetries) throw err

      const waitMs = rateLimitWaitMs(token, options?.cwd, attempt + 1)
      if (waitMs > maxWaitMs) {
        process.stderr.write(
          `[kody gh] rate limit on ${formatGhArgs(args)}; reset wait ${formatDuration(waitMs)} exceeds max ${formatDuration(maxWaitMs)}\n`,
        )
        throw err
      }

      process.stderr.write(
        `[kody gh] rate limit on ${formatGhArgs(args)}; retry ${attempt + 1}/${maxRetries} after ${formatDuration(waitMs)}\n`,
      )
      sleepSync(waitMs)
    }
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const stderr = (err as { stderr?: unknown }).stderr
    if (Buffer.isBuffer(stderr)) return `${err.message}\n${stderr.toString("utf-8")}`
    if (typeof stderr === "string") return `${err.message}\n${stderr}`
    return err.message
  }
  return String(err)
}

function isRateLimitError(err: unknown): boolean {
  const msg = errorMessage(err)
  return /rate limit exceeded|secondary rate limit|abuse detection/i.test(msg) && /HTTP 403|rate limit/i.test(msg)
}

function rateLimitWaitMs(token: string | undefined, cwd: string | undefined, retryNumber: number): number {
  const resetMs = readCoreRateLimitResetMs(token, cwd)
  if (typeof resetMs === "number") {
    return Math.max(0, resetMs - Date.now() + 1_000)
  }
  const base = envInt("KODY_GH_RATE_LIMIT_BASE_DELAY_MS", DEFAULT_RATE_LIMIT_BASE_DELAY_MS)
  return base * 2 ** Math.max(0, retryNumber - 1)
}

function readCoreRateLimitResetMs(token: string | undefined, cwd: string | undefined): number | null {
  try {
    const env: NodeJS.ProcessEnv = token ? { ...process.env, GH_TOKEN: token } : { ...process.env }
    const raw = execFileSync("gh", ["api", "rate_limit", "--jq", ".resources.core.reset"], {
      encoding: "utf-8",
      timeout: API_TIMEOUT_MS,
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    const seconds = Number(raw)
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : null
  } catch {
    return null
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) return
  const buffer = new SharedArrayBuffer(4)
  const view = new Int32Array(buffer)
  Atomics.wait(view, 0, 0, ms)
}

function formatGhArgs(args: string[]): string {
  return `gh ${args.slice(0, 4).join(" ")}${args.length > 4 ? " ..." : ""}`
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  const seconds = Math.ceil(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m${rest}s` : `${minutes}m`
}

export function getIssue(issueNumber: number, cwd?: string): IssueData {
  const output = gh(["issue", "view", String(issueNumber), "--json", "number,title,body,comments,labels,url"], {
    cwd,
    preferRepoToken: true,
  })
  const parsed = JSON.parse(output)
  if (typeof parsed?.title !== "string") {
    throw new Error(`Issue #${issueNumber}: unexpected response shape`)
  }
  const url = typeof parsed.url === "string" ? parsed.url : undefined
  return {
    number: parsed.number ?? issueNumber,
    title: parsed.title,
    body: parsed.body ?? "",
    url,
    isPullRequest: typeof url === "string" && /\/pull\/\d+$/.test(url),
    comments: (parsed.comments ?? []).map((c: { body: string; createdAt: string; author?: { login?: string } }) => ({
      body: c.body ?? "",
      author: c.author?.login ?? "unknown",
      createdAt: c.createdAt ?? "",
    })),
    labels: Array.isArray(parsed.labels)
      ? (parsed.labels as Array<{ name?: string }>).map((l) => l.name ?? "").filter((n) => n.length > 0)
      : [],
  }
}

/**
 * Neutralize any `@kody X` substring in an agent-authored comment body so
 * GHA's `contains(comment.body, '@kody')` filter doesn't self-fire on it.
 * Inserts a zero-width space between `@` and `kody`; humans see the same
 * text, the filter no longer matches. Orchestrator-side trigger comments
 * (startFlow, dispatch, advanceFlow, finishFlow) go through execFileSync
 * directly and are exempt.
 */
export function stripKodyMentions(body: string): string {
  // Preserve case via capture groups. Match any `@kody…` substring (including
  // `@kody-bot`) because GHA's contains() does a raw substring check.
  return body.replace(/(@)(kody)/gi, "$1​$2")
}

/**
 * Detect a bot self-dispatch attempt: a comment whose body STARTS with
 * `@kody <slug>` (the dispatch grammar). Returns the slug if matched, null
 * otherwise.
 *
 * Why we look at the start only: chat replies, status pings, and prose can
 * mention `@kody` mid-sentence — those are fine. The dispatch contract is
 * "first word is @kody, second word is an executable" — the same shape a
 * human types to trigger a stage. When the BOT writes that shape, it's
 * either (a) a relic of the old comment-based self-dispatch (now banned —
 * use `runExecutableChain` or `dispatchExecutable`) or (b) a future helper
 * that bypassed the typed dispatch API. Either way, fail loudly so the
 * regression is visible instead of silently filtered downstream by the
 * bot-author gate in `dispatch.ts`.
 */
export function detectBotDispatchShape(body: string): string | null {
  const trimmed = body.replace(/^\s+/, "")
  // Match `@kody <slug>` where slug starts with a letter and is kebab-safe.
  // Stop at whitespace/end so we don't mis-match prose continuations.
  const m = trimmed.match(/^@kody\s+([a-z][a-z0-9-]*)\b/i)
  return m ? m[1]!.toLowerCase() : null
}

export class BotDispatchCommentError extends Error {
  constructor(slug: string) {
    super(
      `bot self-dispatch via @kody comments is banned. ` +
        `Refusing to post "@kody ${slug} …" — use runExecutableChain (same-run) ` +
        `or dispatchExecutable (cross-run) instead. ` +
        `See docs/capability-dispatch.md for the contract.`,
    )
    this.name = "BotDispatchCommentError"
  }
}

/**
 * True iff the current process is running under a bot identity (App
 * installation token or kody-bot user). Used by `postIssueComment` /
 * `postPrReviewComment` to scope the dispatch-shape ban: a human (PAT)
 * driving the dashboard chat is unaffected, only bot writes are blocked.
 */
function isRunningAsBot(): boolean {
  // GitHub Actions sets these when running under the App. The dashboard
  // server-side does not set GITHUB_ACTIONS, so chat-via-PAT bypasses.
  if (process.env.GITHUB_ACTIONS !== "true") return false
  const actor = (process.env.GITHUB_ACTOR ?? "").toLowerCase()
  if (actor.endsWith("[bot]") || actor === "kody-bot" || actor === "kodyade") return true
  // KODY_APP_ID is only present when kody.yml minted an App token.
  return !!process.env.KODY_APP_ID
}

export function postIssueComment(issueNumber: number, body: string, cwd?: string): void {
  if (isRunningAsBot()) {
    const slug = detectBotDispatchShape(body)
    if (slug) throw new BotDispatchCommentError(slug)
  }
  try {
    gh(["issue", "comment", String(issueNumber), "--body-file", "-"], {
      input: stripKodyMentions(body),
      cwd,
      preferRepoToken: true,
    })
  } catch (err) {
    process.stderr.write(
      `[kody] failed to post comment on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}

export function truncate(s: string, maxBytes: number): string {
  if (s.length <= maxBytes) return s
  return `${s.slice(0, maxBytes)}… (+${s.length - maxBytes} chars)`
}

/** Default comment window, shared by loadIssueContext and runFlow. */
export const DEFAULT_COMMENT_LIMIT = 12
// 16KB/comment is enough to pass through a full research artifact (findings
// + ambiguities) without clipping. Override per-project via kody.config.json
// > issueContext > commentMaxBytes.
export const DEFAULT_COMMENT_MAX_BYTES = 16_000

/**
 * Format issue comments into the markdown block used by prompt templates
 * (`{{issue.commentsFormatted}}`). Most-recent first, capped at `limit`
 * comments and `maxBytes` per body. Shared so every issue-driven
 * executable (plan, research, run) renders comments identically.
 */
export function formatIssueComments(comments: IssueComment[], limit: number, maxBytes: number): string {
  const sorted = [...comments].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  const kept = sorted.slice(0, limit)
  if (kept.length === 0) return "(no comments yet)"
  return kept
    .map((c) => `- **${c.author}** (${c.createdAt}):\n  ${truncate(c.body, maxBytes).replace(/\n/g, "\n  ")}`)
    .join("\n\n")
}

export function parsePrNumber(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : null
}

export interface PrData {
  number: number
  title: string
  body: string
  headRefName: string
  baseRefName: string
  state: string
}

export function getPr(prNumber: number, cwd?: string): PrData {
  const output = gh(["pr", "view", String(prNumber), "--json", "number,title,body,headRefName,baseRefName,state"], {
    cwd,
    preferRepoToken: true,
  })
  const parsed = JSON.parse(output)
  if (typeof parsed?.title !== "string") {
    throw new Error(`PR #${prNumber}: unexpected response shape`)
  }
  return {
    number: parsed.number ?? prNumber,
    title: parsed.title,
    body: parsed.body ?? "",
    headRefName: String(parsed.headRefName ?? ""),
    baseRefName: String(parsed.baseRefName ?? ""),
    state: String(parsed.state ?? ""),
  }
}

export function getPrDiff(prNumber: number, cwd?: string): string {
  try {
    return gh(["pr", "diff", String(prNumber)], { cwd, preferRepoToken: true })
  } catch (err) {
    process.stderr.write(
      `[kody] failed to fetch diff for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return ""
  }
}

export interface PrReview {
  body: string
  state: string
  author: string
  submittedAt: string
}

export function getPrReviews(prNumber: number, cwd?: string): PrReview[] {
  try {
    const output = gh(["pr", "view", String(prNumber), "--json", "reviews"], {
      cwd,
      preferRepoToken: true,
    })
    const parsed = JSON.parse(output)
    if (!Array.isArray(parsed?.reviews)) return []
    return parsed.reviews.map(
      (r: { body?: string; state?: string; author?: { login?: string }; submittedAt?: string }) => ({
        body: r.body ?? "",
        state: r.state ?? "",
        author: r.author?.login ?? "unknown",
        submittedAt: r.submittedAt ?? "",
      }),
    )
  } catch {
    return []
  }
}

export interface PrComment {
  body: string
  author: string
  createdAt: string
}

/**
 * Fetch non-bot issue-style comments on a PR (what `gh pr comment` creates).
 * These are distinct from formal PR reviews fetched by getPrReviews.
 */
export function getPrComments(prNumber: number, cwd?: string): PrComment[] {
  try {
    const output = gh(["pr", "view", String(prNumber), "--json", "comments"], {
      cwd,
      preferRepoToken: true,
    })
    const parsed = JSON.parse(output)
    if (!Array.isArray(parsed?.comments)) return []
    return parsed.comments
      .map((c: { body?: string; author?: { login?: string }; createdAt?: string }) => ({
        body: c.body ?? "",
        author: c.author?.login ?? "unknown",
        createdAt: c.createdAt ?? "",
      }))
      .filter((c: PrComment) => c.body.trim().length > 0)
  } catch {
    return []
  }
}

/**
 * Matches a review body produced by the `review` executable or a similarly
 * structured human-written review. The review prompt requires a verdict
 * heading; a body without it is a trigger/status/state comment, not a review.
 */
const VERDICT_HEADING = /(^|\n)\s*#{1,6}\s*Verdict\b\s*:?/i

/**
 * Whether a PR comment body is shaped like a review. True iff the body
 * contains a `## Verdict:` heading anywhere. Exported for direct testing.
 */
export function isReviewShaped(body: string): boolean {
  return VERDICT_HEADING.test(body)
}

/**
 * Return the most recent review body on a PR.
 *
 * A "review" is either:
 *   1. A formal PR review (submitted through GitHub's review UI — always a
 *      review by construction), or
 *   2. An issue comment whose body contains a `## Verdict:` heading (the
 *      contract our review executable emits).
 *
 * Everything else — trigger comments like `@kody fix`, bot status pings
 * (⚙️/✅/⚠️/👀 …), task-state blocks, random chatter — is ignored. This
 * replaces the earlier hand-maintained prefix blacklist, which silently
 * drifted as new bot comment shapes were added.
 *
 * Falls back to the PR body when no review is present (first-run case).
 */
export function getPrLatestReviewBody(prNumber: number, cwd?: string): string {
  const reviews = getPrReviews(prNumber, cwd)
    .filter((r) => r.body.trim().length > 0)
    .map((r) => ({ body: r.body, at: r.submittedAt }))
  const comments = getPrComments(prNumber, cwd)
    .filter((c) => isReviewShaped(c.body))
    .map((c) => ({ body: c.body, at: c.createdAt }))

  const all = [...reviews, ...comments].sort((a, b) => (b.at || "").localeCompare(a.at || ""))
  if (all.length > 0) return all[0]!.body

  const pr = getPr(prNumber, cwd)
  return pr.body
}

export function postPrReviewComment(prNumber: number, body: string, cwd?: string): void {
  if (isRunningAsBot()) {
    const slug = detectBotDispatchShape(body)
    if (slug) throw new BotDispatchCommentError(slug)
  }
  try {
    gh(["pr", "comment", String(prNumber), "--body-file", "-"], {
      input: stripKodyMentions(body),
      cwd,
      preferRepoToken: true,
    })
  } catch (err) {
    process.stderr.write(
      `[kody] failed to post review comment on PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}
