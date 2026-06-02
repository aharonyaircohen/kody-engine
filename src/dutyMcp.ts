/**
 * In-process MCP server exposing typed "duty primitives" to the job-tick agent.
 *
 * Why this exists: duties used to be markdown bodies with `Bash` + `gh` access.
 * That escape hatch let any duty post `@kody <verb>` comments that the engine's
 * webhook receiver silently drops to prevent self-dispatch loops — duties
 * therefore "succeeded" while their dispatched verbs never ran. The fix isn't
 * another guard or per-duty rewrite; it's removing the escape hatch entirely.
 *
 * A duty declares the tools it needs (`tools: [...]` frontmatter); the engine
 * loads ONLY those (plus `submit_state`) and revokes `Bash`/`Read`. The duty
 * author can no longer post raw comments, shell out, or invent a new dispatch
 * path — the toolbox simply doesn't contain those affordances.
 *
 * Tools surfaced here are high-level *intents*, not low-level primitives:
 *   - list_prs_to_repair: open non-draft PRs with computed repair signals
 *   - sync_pr / fix_ci_pr / resolve_pr: dispatch the matching workflow_dispatch
 *     run (never posts an @kody comment — the engine ban no longer matters)
 *   - recommend_to_operator: post a single comment with the operator @-mention
 *     substituted server-side from config.github.operators
 *   - read_ledger: read the first open issue with a label, returning JSON
 *     between sentinel markers (e.g. kody:cto-decisions trust ledger)
 *
 * The behind_by computation is done HERE — the LLM never sees `gh`, never
 * crafts a compare URL, never measures drift incorrectly. One call returns the
 * whole structured world the duty needs to make its decision.
 */

import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { gh } from "./issue.js"

export interface DutyMcpHandle {
  /** Config object to drop into `mcpServers["kody-duty"]`. */
  server: McpSdkServerConfigWithInstance
}

interface DutyMcpOptions {
  /** Repo slug "owner/name" — read from kody.config.json/runtime context. */
  repoSlug: string
  /**
   * The operator @-mention prefix (e.g. "@aguyaharonyair") substituted into
   * recommend_to_operator comments. Empty string when the duty's `mentions:`
   * frontmatter is blank — the comment is then unmentioned (still posted).
   */
  operatorMention: string
  /** Workflow file to dispatch (default "kody.yml"). */
  workflowFile?: string
  /**
   * Slug of the duty currently running (`ctx.data.jobSlug`). Stamped onto every
   * `recommend_to_operator` comment as `<!-- kody-duty: <slug> -->` so the
   * dashboard keys trust per DUTY, not per persona. Omitted → no stamp (the
   * dashboard then falls back to the persona slug).
   */
  dutySlug?: string
}

interface RepairCandidate {
  number: number
  title: string
  headSha: string
  baseRef: string
  isDraft: boolean
  /** "CONFLICTING" | "MERGEABLE" | "UNKNOWN" */
  mergeable: string
  /** Highest-severity CI conclusion across rolled-up checks, or "RUNNING" / "PASSING". */
  ciStatus: "PASSING" | "FAILING" | "RUNNING" | "UNKNOWN"
  /** Commits the head branch is behind base. -1 if compare failed. */
  behindBy: number
  updatedAt: string
}

const FAIL_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "CANCELLED"])
const RUNNING_STATUSES = new Set(["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"])

function summarizeCiStatus(rollup: unknown): RepairCandidate["ciStatus"] {
  if (!Array.isArray(rollup) || rollup.length === 0) return "UNKNOWN"
  let hasRunning = false
  for (const check of rollup as Array<{ status?: string; conclusion?: string }>) {
    const status = String(check.status ?? "").toUpperCase()
    const conclusion = String(check.conclusion ?? "").toUpperCase()
    if (FAIL_CONCLUSIONS.has(conclusion)) return "FAILING"
    if (!conclusion && RUNNING_STATUSES.has(status)) hasRunning = true
  }
  return hasRunning ? "RUNNING" : "PASSING"
}

function computeBehindBy(repoSlug: string, base: string, head: string): number {
  try {
    const raw = gh(["api", `repos/${repoSlug}/compare/${base}...${head}`, "--jq", ".behind_by"])
    const n = Number(raw.trim())
    return Number.isFinite(n) ? n : -1
  } catch {
    return -1
  }
}

function listRepairCandidates(repoSlug: string): RepairCandidate[] {
  const raw = gh([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,headRefName,headRefOid,baseRefName,isDraft,mergeable,statusCheckRollup,updatedAt",
  ])
  const prs = JSON.parse(raw) as Array<{
    number: number
    title: string
    headRefName: string
    headRefOid: string
    baseRefName: string
    isDraft: boolean
    mergeable: string
    statusCheckRollup: unknown
    updatedAt: string
  }>
  return prs
    .filter((p) => !p.isDraft)
    .map((p) => {
      const ciStatus = summarizeCiStatus(p.statusCheckRollup)
      // Only spend a compare API call when the PR is not conflicting and CI is
      // not failing — those are the only paths that route to `sync` anyway.
      const mergeable = String(p.mergeable ?? "UNKNOWN").toUpperCase()
      const behindBy =
        mergeable === "CONFLICTING" || ciStatus === "FAILING"
          ? 0
          : computeBehindBy(repoSlug, p.baseRefName, p.headRefName)
      return {
        number: p.number,
        title: p.title,
        headSha: p.headRefOid,
        baseRef: p.baseRefName,
        isDraft: false,
        mergeable,
        ciStatus,
        behindBy,
        updatedAt: p.updatedAt,
      }
    })
}

function dispatchVerb(
  workflowFile: string,
  executable: string,
  prNumber: number,
): { ok: true } | { ok: false; error: string } {
  // PR-repair verbs are just a workflow_dispatch keyed by PR number — same path
  // as the general dispatchWorkflow tool (defined below; hoisted).
  return dispatchWorkflow(workflowFile, executable, prNumber)
}

function postRecommendation(
  prNumber: number,
  mention: string,
  message: string,
  dutySlug?: string,
): { ok: true } | { ok: false; error: string } {
  const mentioned = mention ? `${mention} ${message}` : message
  // Stamp the emitting duty so the dashboard keys trust per duty (code, not LLM).
  const body = dutySlug ? `${mentioned}\n\n<!-- kody-duty: ${dutySlug} -->` : mentioned
  try {
    // gh CLI strips `@kody …` self-dispatch via stripKodyMentions in the
    // postIssueComment path — but recommend_to_operator never starts with
    // `@kody <slug>`, so the BotDispatchCommentError check is a non-issue.
    gh(["pr", "comment", String(prNumber), "--body", body])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

interface LedgerResult {
  found: boolean
  issueNumber?: number
  /** Parsed JSON between the start/end sentinel markers, or null if not found. */
  payload: unknown
}

function readLedger(label: string): LedgerResult {
  const startTag = `<!-- ${label}:start -->`
  const endTag = `<!-- ${label}:end -->`
  try {
    const raw = gh(["issue", "list", "--state", "open", "--label", label, "--limit", "5", "--json", "number,body"])
    const issues = JSON.parse(raw) as Array<{ number: number; body: string }>
    if (issues.length === 0) return { found: false, payload: null }
    const issue = issues.sort((a, b) => a.number - b.number)[0]
    const body = issue?.body ?? ""
    const startIdx = body.indexOf(startTag)
    const endIdx = body.indexOf(endTag)
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
      return { found: true, issueNumber: issue?.number, payload: null }
    }
    const between = body.slice(startIdx + startTag.length, endIdx)
    const fenceMatch = between.match(/```json\s*([\s\S]*?)```/)
    if (!fenceMatch) return { found: true, issueNumber: issue?.number, payload: null }
    try {
      return { found: true, issueNumber: issue?.number, payload: JSON.parse(fenceMatch[1]!) }
    } catch {
      return { found: true, issueNumber: issue?.number, payload: null }
    }
  } catch (err) {
    return { found: false, payload: { error: err instanceof Error ? err.message : String(err) } }
  }
}

// ---------------------------------------------------------------------------
// Duty trust gate. The dashboard writes per-duty trust to a JSON file on the
// `kody-state` branch (`.kody/state/trust.json`, shape `{ duties: { <slug>:
// { mode: "ask" | "auto", ... } } }`). The engine reads it to decide whether a
// trusted duty may self-dispatch (mode "auto") or must recommend (mode "ask").
// Fail-safe by construction: ANY uncertainty (no file, no entry, parse/API
// error, missing slug) resolves to "ask" — the engine never auto-acts on a
// duty it can't positively confirm is trusted.
// ---------------------------------------------------------------------------

export type DutyTrustMode = "ask" | "auto"
const TRUST_FILE_PATH = ".kody/state/trust.json"
const TRUST_STATE_BRANCH = "kody-state"

/** Pure: a duty's trust mode from the raw trust.json text. Fail-safe → "ask". */
export function parseDutyTrustMode(rawJson: string, dutySlug: string): DutyTrustMode {
  try {
    const parsed = JSON.parse(rawJson) as { duties?: Record<string, { mode?: string }> }
    return parsed?.duties?.[dutySlug]?.mode === "auto" ? "auto" : "ask"
  } catch {
    return "ask"
  }
}

/**
 * Read a duty's trust mode from `.kody/state/trust.json` on `kody-state`.
 * Fail-safe: any miss → "ask". Not wired into dispatch yet — pure read.
 */
export function readDutyTrustMode(repoSlug: string, dutySlug?: string): DutyTrustMode {
  if (!dutySlug) return "ask"
  try {
    const b64 = gh(["api", `repos/${repoSlug}/contents/${TRUST_FILE_PATH}?ref=${TRUST_STATE_BRANCH}`, "--jq", ".content"])
    const json = Buffer.from(b64.trim(), "base64").toString("utf-8")
    return parseDutyTrustMode(json, dutySlug)
  } catch {
    return "ask"
  }
}

// ---------------------------------------------------------------------------
// General duty primitives (not PR-repair-specific). These give a locked duty
// the affordances it needs WITHOUT raw `gh`, and — critically — make the
// duplication-prone actions (create issue / comment) idempotent IN CODE, keyed
// by a stable hidden marker. The LLM no longer decides whether a duplicate
// exists; the tool looks it up deterministically via the issues API (never the
// laggy search index) and refuses to create a second.
// ---------------------------------------------------------------------------

/** Check-run conclusions that count as a terminal failure (CANCELLED excluded —
 * a cancelled run is usually superseded, not a real CI failure). */
const CHECK_FAIL_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"])
/** Kody's own job check-runs — excluded by default so a duty never reacts to
 * the engine's own activity (which would be self-referential / loop). */
const DEFAULT_IGNORE_CHECKS = ["run", "kody", "job-tick", "goal-tick", "worker-ask", "chat"]

export interface CheckRunsResult {
  sha: string
  state: "RED" | "PENDING" | "GREEN"
  failing: Array<{ name: string; conclusion: string; detailsUrl: string }>
  pending: Array<{ name: string; status: string }>
}

export function readCheckRuns(repoSlug: string, ref: string, ignoreNames: string[]): CheckRunsResult {
  const sha = gh(["api", `repos/${repoSlug}/commits/${ref}`, "--jq", ".sha"]).trim()
  // `--jq '.check_runs[] | {…}'` emits newline-delimited JSON objects (one per
  // line), and `--paginate` concatenates pages — parse line by line.
  const raw = gh([
    "api",
    `repos/${repoSlug}/commits/${sha}/check-runs`,
    "--paginate",
    "--jq",
    ".check_runs[] | {name, status, conclusion, details_url}",
  ])
  const ignore = new Set(ignoreNames.map((n) => n.toLowerCase()))
  const checks = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { name: string; status: string; conclusion: string | null; details_url: string })
    .filter((c) => !ignore.has(String(c.name).toLowerCase()))
  const failing = checks
    .filter((c) => CHECK_FAIL_CONCLUSIONS.has(String(c.conclusion ?? "").toUpperCase()))
    .map((c) => ({ name: c.name, conclusion: String(c.conclusion), detailsUrl: c.details_url }))
  const pending = checks
    .filter((c) => String(c.status).toLowerCase() !== "completed")
    .map((c) => ({ name: c.name, status: c.status }))
  const state: CheckRunsResult["state"] = failing.length > 0 ? "RED" : pending.length > 0 ? "PENDING" : "GREEN"
  return { sha, state, failing, pending }
}

const trackMarker = (key: string): string => `<!-- kody-track:${key} -->`
const commentMarker = (key: string): string => `<!-- kody-track-comment:${key} -->`

export type EnsureIssueResult = { created: boolean; number: number } | { error: string }

export function ensureIssue(repoSlug: string, key: string, title: string, body: string): EnsureIssueResult {
  const marker = trackMarker(key)
  try {
    const raw = gh(["issue", "list", "-R", repoSlug, "--state", "open", "--limit", "100", "--json", "number,body"])
    const issues = JSON.parse(raw) as Array<{ number: number; body: string }>
    const existing = issues.find((i) => (i.body ?? "").includes(marker))
    if (existing) return { created: false, number: existing.number }
    const url = gh(["issue", "create", "-R", repoSlug, "--title", title, "--body-file", "-"], {
      input: `${body}\n\n${marker}`,
    })
    const m = url.trim().match(/\/(\d+)\s*$/)
    if (!m) return { error: `issue created but could not parse its number from: ${url}` }
    return { created: true, number: Number(m[1]) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export type EnsureCommentResult = { posted: boolean } | { error: string }

export function ensureComment(repoSlug: string, issue: number, key: string, body: string): EnsureCommentResult {
  const marker = commentMarker(key)
  try {
    const raw = gh(["issue", "view", String(issue), "-R", repoSlug, "--json", "comments"])
    const parsed = JSON.parse(raw) as { comments?: Array<{ body?: string }> }
    const already = (parsed.comments ?? []).some((c) => (c.body ?? "").includes(marker))
    if (already) return { posted: false }
    gh(["issue", "comment", String(issue), "-R", repoSlug, "--body-file", "-"], { input: `${body}\n\n${marker}` })
    return { posted: true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export function dispatchWorkflow(
  workflowFile: string,
  executable: string,
  issueNumber: number,
): { ok: true } | { ok: false; error: string } {
  try {
    gh(["workflow", "run", workflowFile, "-f", `executable=${executable}`, "-f", `issue_number=${issueNumber}`])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Build the in-process MCP server exposing duty primitives. The tool palette
 * intentionally favors high-level intents (sync_pr, fix_ci_pr) over low-level
 * primitives (gh, http) so the LLM can't compose its way out of the lockdown.
 */
/** Message returned by a dispatch tool when the duty isn't trusted (ASK mode). */
function trustRefusal(dutySlug?: string): string {
  return (
    `Not dispatched: duty \`${dutySlug ?? "?"}\` is in ASK mode (not trusted for autonomy). ` +
    `Do NOT retry the dispatch. Instead notify the operator (use recommend_to_operator, or rely on the ` +
    `tracking issue that already @-mentions them), then submit_state. To let this duty act on its own, ` +
    `grant it Auto on the dashboard Trust page.`
  )
}

export function buildDutyMcpServer(opts: DutyMcpOptions): DutyMcpHandle {
  const workflowFile = opts.workflowFile ?? "kody.yml"

  const listTool = tool(
    "list_prs_to_repair",
    "Return open non-draft PRs with the signals you need to pick a repair: number, title, headSha, baseRef, mergeable (CONFLICTING/MERGEABLE/UNKNOWN), ciStatus (PASSING/FAILING/RUNNING/UNKNOWN), behindBy (commits behind base; 0 for PRs that already match conflicts or CI-failure rules), updatedAt. Drafts are excluded. One call returns everything — do not iterate or paginate.",
    {},
    async () => {
      const candidates = listRepairCandidates(opts.repoSlug)
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ prs: candidates }, null, 2),
          },
        ],
      }
    },
  )

  const makeDispatch = (verb: "sync" | "fix-ci" | "resolve", describe: string) =>
    tool(
      `${verb.replace("-", "_")}_pr`,
      describe,
      {
        pr: z.number().int().positive().describe("PR number to repair."),
      },
      async (args) => {
        // Trust gate: only a duty graduated to "auto" may self-dispatch. An
        // "ask" duty is refused HERE (in code) and told to recommend instead —
        // the autonomy decision can't be skipped by the LLM.
        if (readDutyTrustMode(opts.repoSlug, opts.dutySlug) !== "auto") {
          return { content: [{ type: "text" as const, text: trustRefusal(opts.dutySlug) }] }
        }
        const result = dispatchVerb(workflowFile, verb, args.pr)
        const text = result.ok
          ? `Dispatched \`${verb}\` on PR #${args.pr}. The repair runs in its own workflow_dispatch — wait for the next tick to see the new headSha.`
          : `Dispatch failed for \`${verb}\` on PR #${args.pr}: ${result.error}`
        return {
          content: [{ type: "text" as const, text }],
        }
      },
    )

  const syncTool = makeDispatch(
    "sync",
    "Bring a stale PR up to date with its base branch (merges base → head + pushes). Use when behindBy > 10 AND mergeable !== CONFLICTING AND ciStatus !== FAILING. Returns immediately — the actual merge runs in a separate workflow.",
  )
  const fixCiTool = makeDispatch(
    "fix-ci",
    "Repair a PR whose CI is failing. Use when ciStatus === FAILING. The repair runs in a separate workflow.",
  )
  const resolveTool = makeDispatch(
    "resolve",
    "Resolve merge conflicts on a PR. Use when mergeable === CONFLICTING. The repair runs in a separate workflow.",
  )

  const recommendTool = tool(
    "recommend_to_operator",
    "Post ONE comment on a PR with the operator @-mention prepended. Use this when a verb is NOT graduated in the trust ledger and you want the operator to confirm via the dashboard inbox. The mention handle is substituted from kody.config.json `github.operators` — do not type it yourself.",
    {
      pr: z.number().int().positive().describe("PR number to comment on."),
      body: z
        .string()
        .min(1)
        .describe("Comment body (markdown). Do not include the operator mention — the engine prepends it."),
    },
    async (args) => {
      const result = postRecommendation(args.pr, opts.operatorMention, args.body, opts.dutySlug)
      const text = result.ok
        ? `Recommendation posted on PR #${args.pr}.`
        : `Recommendation failed on PR #${args.pr}: ${result.error}`
      return {
        content: [{ type: "text" as const, text }],
      }
    },
  )

  const ledgerTool = tool(
    "read_ledger",
    "Read the trust ledger (or any sentinel-fenced JSON manifest stored on a labeled issue). Returns `{found, issueNumber, payload}` where payload is the parsed JSON between `<!-- <label>:start -->` and `<!-- <label>:end -->` sentinels. Use `read_ledger({label: 'kody:cto-decisions'})` to look up per-verb graduation modes for the trust gate.",
    {
      label: z
        .string()
        .min(1)
        .describe("GitHub issue label that identifies the manifest issue (e.g. 'kody:cto-decisions')."),
    },
    async (args) => {
      const result = readLedger(args.label)
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    },
  )

  const checkRunsTool = tool(
    "read_check_runs",
    "Read CI for a branch or commit ref (e.g. 'dev'). Returns {sha, state, failing:[{name,conclusion,detailsUrl}], pending:[{name,status}]}. state is RED (≥1 check has a terminal-failure conclusion: failure/timed_out/startup_failure/action_required), PENDING (none failed but some still running), or GREEN (all completed, none failed). Kody's own job check-runs (run/kody/job-tick/…) are excluded by default. This reads the commit's authoritative check-runs — use it instead of guessing CI health from a run list.",
    {
      ref: z.string().min(1).describe("Branch name or commit SHA to read CI for (e.g. 'dev')."),
      ignoreNames: z.array(z.string()).optional().describe("Check names to exclude (default: Kody's own job names)."),
    },
    async (args) => {
      const result = readCheckRuns(opts.repoSlug, args.ref, args.ignoreNames ?? DEFAULT_IGNORE_CHECKS)
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  const ensureIssueTool = tool(
    "ensure_issue",
    "Idempotently ensure ONE open tracking issue exists for `key`. Searches OPEN issues (issues API, not the laggy search index) for `key`'s hidden marker; if found, returns {created:false, number} and creates NOTHING; otherwise creates the issue (title + body, marker appended) and returns {created:true, number}. This is the anti-duplication primitive: use one stable `key` per recurring finding so re-ticks reuse the same issue. Only take follow-up actions (dispatch/comment) when created===true.",
    {
      key: z
        .string()
        .min(1)
        .describe(
          "Stable dedup identity for this finding (e.g. 'dev-ci-red', 'docs-drift:<feature>'). Same key across ticks = same issue.",
        ),
      title: z.string().min(1).describe("Issue title (used only on first creation)."),
      body: z
        .string()
        .min(1)
        .describe(
          "Issue body markdown (used only on first creation). Include the operator mention verbatim if the duty body has one.",
        ),
    },
    async (args) => {
      const result = ensureIssue(opts.repoSlug, args.key, args.title, args.body)
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  const ensureCommentTool = tool(
    "ensure_comment",
    "Idempotently post ONE comment on an issue for `key`. If a comment carrying `key`'s marker already exists on the issue, returns {posted:false}; otherwise posts the comment (marker appended) and returns {posted:true}. Use for a notify/audit comment that must appear exactly once.",
    {
      issue: z.number().int().positive().describe("Issue number to comment on."),
      key: z.string().min(1).describe("Stable dedup identity for this comment (e.g. 'dev-ci-red:dispatched')."),
      body: z.string().min(1).describe("Comment body markdown."),
    },
    async (args) => {
      const result = ensureComment(opts.repoSlug, args.issue, args.key, args.body)
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  const dispatchTool = tool(
    "dispatch_workflow",
    "Dispatch a kody.yml workflow_dispatch run for an executable against an issue (the cross-run bot→engine path; a bot `@kody` comment would be dropped). E.g. dispatch_workflow({executable:'run', issueNumber:<n>}) opens a fix PR from a tracking issue. Returns {ok} or {ok:false,error}.",
    {
      executable: z.string().min(1).describe("Executable/stage to run (e.g. 'run')."),
      issueNumber: z.number().int().positive().describe("Issue (or PR) number forwarded as issue_number."),
    },
    async (args) => {
      // Trust gate — see makeDispatch. "ask" duties cannot self-dispatch.
      if (readDutyTrustMode(opts.repoSlug, opts.dutySlug) !== "auto") {
        return { content: [{ type: "text" as const, text: trustRefusal(opts.dutySlug) }] }
      }
      const result = dispatchWorkflow(workflowFile, args.executable, args.issueNumber)
      const text = result.ok
        ? `Dispatched \`${args.executable}\` on #${args.issueNumber} via workflow_dispatch.`
        : `Dispatch failed for \`${args.executable}\` on #${args.issueNumber}: ${result.error}`
      return { content: [{ type: "text" as const, text }] }
    },
  )

  const server = createSdkMcpServer({
    name: "kody-duty",
    version: "0.1.0",
    tools: [
      listTool,
      syncTool,
      fixCiTool,
      resolveTool,
      recommendTool,
      ledgerTool,
      checkRunsTool,
      ensureIssueTool,
      ensureCommentTool,
      dispatchTool,
    ],
  })

  return { server }
}

/** Set of MCP tool names this server exposes — for allowedTools wiring. */
export const DUTY_MCP_TOOL_NAMES = [
  "list_prs_to_repair",
  "sync_pr",
  "fix_ci_pr",
  "resolve_pr",
  "recommend_to_operator",
  "read_ledger",
  "read_check_runs",
  "ensure_issue",
  "ensure_comment",
  "dispatch_workflow",
] as const
