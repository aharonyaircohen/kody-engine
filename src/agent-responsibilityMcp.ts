/**
 * In-process MCP server exposing typed "agentResponsibility primitives" to the agent-responsibility-tick agent.
 *
 * Why this exists: agentResponsibilities used to be markdown bodies with `Bash` + `gh` access.
 * That escape hatch let any agentResponsibility post `@kody <verb>` comments that the engine's
 * webhook receiver silently drops to prevent self-dispatch loops — agentResponsibilities
 * therefore "succeeded" while their dispatched verbs never ran. The fix isn't
 * another guard or per-agentResponsibility rewrite; it's removing the escape hatch entirely.
 *
 * A agentResponsibility declares the tools it needs (`tools: [...]` metadata); the engine
 * loads ONLY those (plus `submit_state`) and revokes `Bash`/`Read`. The agentResponsibility
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
 *     between sentinel markers
 *
 * The behind_by computation is done HERE — the LLM never sees `gh`, never
 * crafts a compare URL, never measures drift incorrectly. One call returns the
 * whole structured world the agentResponsibility needs to make its decision.
 *
 * Transport: tool definitions are extracted into `agentResponsibilityToolDefinitions` so the
 * same handlers power both the in-process MCP server (via claude-agent-sdk)
 * and the HTTP MCP server (via @modelcontextprotocol/sdk).
 */

import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk"
import type { ZodRawShape } from "zod"
import { z } from "zod"
import { gh } from "./issue.js"
import { readStateText, type StateRepoConfig } from "./stateRepo.js"

export interface AgentResponsibilityMcpHandle {
  /** Config object to drop into `mcpServers["kody-agentResponsibility"]`. */
  server: McpSdkServerConfigWithInstance
}

interface AgentResponsibilityMcpOptions {
  /** Repo slug "owner/name" — read from kody.config.json/runtime context. */
  repoSlug: string
  /** Canonical Kody state location for this repo. Defaults from repoSlug. */
  state?: StateRepoConfig["state"]
  /**
   * The operator @-mention prefix (e.g. "@aguyaharonyair") substituted into
   * recommend_to_operator comments. Empty string when the agentResponsibility's `mentions:`
   * metadata is blank — the comment is then unmentioned (still posted).
   */
  operatorMention: string
  /** Workflow file to dispatch (default "kody.yml"). */
  workflowFile?: string
  /**
   * Slug of the agentResponsibility currently running (`ctx.data.jobSlug`). Stamped onto every
   * `recommend_to_operator` comment as `<!-- kody-agentResponsibility: <slug> -->` so the
   * dashboard keys trust per AGENT_RESPONSIBILITY, not per agent. Omitted → no stamp (the
   * dashboard then falls back to the agent slug).
   */
  agentResponsibilitySlug?: string
}

// ────────────────────────────────────────────────────────────────────────────
// Tool definition shape (transport-agnostic).
// ────────────────────────────────────────────────────────────────────────────

export type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}>

export interface AgentResponsibilityToolDefinition {
  name: string
  description: string
  inputSchema: ZodRawShape
  handler: ToolHandler
}

// ────────────────────────────────────────────────────────────────────────────
// Repair candidate / CI summarization (unchanged from previous impl).
// ────────────────────────────────────────────────────────────────────────────

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
  agentResponsibility: string,
  prNumber: number,
): { ok: true } | { ok: false; error: string } {
  return dispatchWorkflow(workflowFile, agentResponsibility, prNumber)
}

function postRecommendation(
  prNumber: number,
  mention: string,
  message: string,
  agentResponsibilitySlug?: string,
): { ok: true } | { ok: false; error: string } {
  const mentioned = mention ? `${mention} ${message}` : message
  const body = agentResponsibilitySlug
    ? `${mentioned}\n\n<!-- kody-agentResponsibility: ${agentResponsibilitySlug} -->`
    : mentioned
  try {
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
// AgentResponsibility trust gate.
// ---------------------------------------------------------------------------

export type AgentResponsibilityTrustMode = "ask" | "auto"
const TRUST_FILE_PATH = "state/trust.json"

export function parseAgentResponsibilityTrustMode(
  rawJson: string,
  agentResponsibilitySlug: string,
): AgentResponsibilityTrustMode {
  try {
    const parsed = JSON.parse(rawJson) as { agentResponsibilities?: Record<string, { mode?: string }> }
    return parsed?.agentResponsibilities?.[agentResponsibilitySlug]?.mode === "auto" ? "auto" : "ask"
  } catch {
    return "ask"
  }
}

function defaultStateForRepoSlug(repoSlug: string): StateRepoConfig["state"] {
  const [owner, repo] = repoSlug.split("/")
  return { repo: `${owner}/kody-state`, path: repo ?? repoSlug }
}

export function readAgentResponsibilityTrustMode(
  repoSlug: string,
  agentResponsibilitySlug?: string,
): AgentResponsibilityTrustMode
export function readAgentResponsibilityTrustMode(
  state: StateRepoConfig["state"] | undefined,
  repoSlug: string,
  agentResponsibilitySlug?: string,
): AgentResponsibilityTrustMode
export function readAgentResponsibilityTrustMode(
  stateOrRepoSlug: StateRepoConfig["state"] | string | undefined,
  repoSlugOrAgentResponsibilitySlug?: string,
  maybeAgentResponsibilitySlug?: string,
): AgentResponsibilityTrustMode {
  const state = typeof stateOrRepoSlug === "string" ? undefined : stateOrRepoSlug
  const repoSlug = typeof stateOrRepoSlug === "string" ? stateOrRepoSlug : (repoSlugOrAgentResponsibilitySlug ?? "")
  const agentResponsibilitySlug =
    typeof stateOrRepoSlug === "string" ? repoSlugOrAgentResponsibilitySlug : maybeAgentResponsibilitySlug
  if (!agentResponsibilitySlug) return "ask"
  try {
    const loaded = readStateText({ state: state ?? defaultStateForRepoSlug(repoSlug) }, undefined, TRUST_FILE_PATH)
    return loaded ? parseAgentResponsibilityTrustMode(loaded.content, agentResponsibilitySlug) : "ask"
  } catch {
    return "ask"
  }
}

// ---------------------------------------------------------------------------
// Read-back primitive.
// ---------------------------------------------------------------------------

export interface ThreadResult {
  number: number
  title: string
  state: string
  labels: string[]
  comments: Array<{ author: string; createdAt: string; body: string }>
}

const THREAD_BODY_MAX = 4000

export function readThread(repoSlug: string, number: number, limit = 10): ThreadResult {
  const meta = JSON.parse(gh(["api", `repos/${repoSlug}/issues/${number}`])) as {
    title?: string
    state?: string
    labels?: Array<{ name?: string }>
  }
  const rawComments = JSON.parse(gh(["api", `repos/${repoSlug}/issues/${number}/comments?per_page=100`])) as Array<{
    user?: { login?: string }
    created_at?: string
    body?: string
  }>
  const comments = rawComments.slice(-Math.max(1, limit)).map((c) => ({
    author: c.user?.login ?? "?",
    createdAt: c.created_at ?? "",
    body: (c.body ?? "").slice(0, THREAD_BODY_MAX),
  }))
  return {
    number,
    title: meta.title ?? "",
    state: meta.state ?? "",
    labels: (meta.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
    comments,
  }
}

// ---------------------------------------------------------------------------
// Idempotency primitives.
// ---------------------------------------------------------------------------

const CHECK_FAIL_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"])
const DEFAULT_IGNORE_CHECKS = ["run", "kody", "agent-responsibility-tick", "agent-ask", "chat"]

export interface CheckRunsResult {
  sha: string
  state: "RED" | "PENDING" | "GREEN"
  failing: Array<{ name: string; conclusion: string; detailsUrl: string }>
  pending: Array<{ name: string; status: string }>
}

export function readCheckRuns(repoSlug: string, ref: string, ignoreNames: string[]): CheckRunsResult {
  const sha = gh(["api", `repos/${repoSlug}/commits/${ref}`, "--jq", ".sha"]).trim()
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
  agentResponsibility: string,
  issueNumber: number,
): { ok: true } | { ok: false; error: string } {
  try {
    gh([
      "workflow",
      "run",
      workflowFile,
      "-f",
      `agentResponsibility=${agentResponsibility}`,
      "-f",
      `issue_number=${issueNumber}`,
    ])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Trust gate for dispatch tools.
// ---------------------------------------------------------------------------

const GATE_EXEMPT_DUTIES: ReadonlySet<string> = new Set(["qa-engineer", "ui-review"])

export function isDispatchGated(
  agentResponsibility: string | null | undefined,
  mode: AgentResponsibilityTrustMode,
): boolean {
  if (mode === "auto") return false
  if (agentResponsibility && GATE_EXEMPT_DUTIES.has(agentResponsibility)) return false
  return true
}

function trustRefusal(agentResponsibilitySlug?: string): string {
  return (
    `Not dispatched: agentResponsibility \`${agentResponsibilitySlug ?? "?"}\` is in ASK mode (not trusted for autonomy). ` +
    `Do NOT retry the dispatch. Instead notify the operator (use recommend_to_operator, or rely on the ` +
    `tracking issue that already @-mentions them), then submit_state. To let this agentResponsibility act on its own, ` +
    `grant it Auto on the dashboard Trust page.`
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Tool definitions (transport-agnostic).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build all agentResponsibility tool definitions. Used by both adapters.
 */
export function agentResponsibilityToolDefinitions(
  opts: AgentResponsibilityMcpOptions,
): AgentResponsibilityToolDefinition[] {
  const workflowFile = opts.workflowFile ?? "kody.yml"

  const listTool: AgentResponsibilityToolDefinition = {
    name: "list_prs_to_repair",
    description:
      "Return open non-draft PRs with the signals you need to pick a repair: number, title, headSha, baseRef, mergeable (CONFLICTING/MERGEABLE/UNKNOWN), ciStatus (PASSING/FAILING/RUNNING/UNKNOWN), behindBy (commits behind base; 0 for PRs that already match conflicts or CI-failure rules), updatedAt. Drafts are excluded. One call returns everything — do not iterate or paginate.",
    inputSchema: {},
    handler: async () => {
      const candidates = listRepairCandidates(opts.repoSlug)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ prs: candidates }, null, 2),
          },
        ],
      }
    },
  }

  const makeDispatch = (verb: "sync" | "fix-ci" | "resolve", describe: string): AgentResponsibilityToolDefinition => ({
    name: `${verb.replace("-", "_")}_pr`,
    description: describe,
    inputSchema: {
      pr: z.number().int().positive().describe("PR number to repair."),
    },
    handler: async (args) => {
      const pr = Number(args.pr)
      if (
        isDispatchGated(verb, readAgentResponsibilityTrustMode(opts.state, opts.repoSlug, opts.agentResponsibilitySlug))
      ) {
        return { content: [{ type: "text", text: trustRefusal(opts.agentResponsibilitySlug) }] }
      }
      const result = dispatchVerb(workflowFile, verb, pr)
      const text = result.ok
        ? `Dispatched \`${verb}\` on PR #${pr}. The repair runs in its own workflow_dispatch — wait for the next tick to see the new headSha.`
        : `Dispatch failed for \`${verb}\` on PR #${pr}: ${result.error}`
      return { content: [{ type: "text", text }] }
    },
  })

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

  const recommendTool: AgentResponsibilityToolDefinition = {
    name: "recommend_to_operator",
    description:
      "Post ONE comment on a PR with the operator @-mention prepended. Use this when a agentResponsibility is in ASK mode and you want the operator to confirm via the dashboard inbox. The mention handle is substituted from kody.config.json `github.operators` — do not type it yourself.",
    inputSchema: {
      pr: z.number().int().positive().describe("PR number to comment on."),
      body: z
        .string()
        .min(1)
        .describe("Comment body (markdown). Do not include the operator mention — the engine prepends it."),
    },
    handler: async (args) => {
      const pr = Number(args.pr)
      const body = String(args.body ?? "")
      const result = postRecommendation(pr, opts.operatorMention, body, opts.agentResponsibilitySlug)
      const text = result.ok
        ? `Recommendation posted on PR #${pr}.`
        : `Recommendation failed on PR #${pr}: ${result.error}`
      return { content: [{ type: "text", text }] }
    },
  }

  const ledgerTool: AgentResponsibilityToolDefinition = {
    name: "read_ledger",
    description:
      "Read any sentinel-fenced JSON manifest stored on a labeled issue. Returns `{found, issueNumber, payload}` where payload is the parsed JSON between `<!-- <label>:start -->` and `<!-- <label>:end -->` sentinels.",
    inputSchema: {
      label: z.string().min(1).describe("GitHub issue label that identifies the manifest issue."),
    },
    handler: async (args) => {
      const label = String(args.label ?? "")
      const result = readLedger(label)
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    },
  }

  const checkRunsTool: AgentResponsibilityToolDefinition = {
    name: "read_check_runs",
    description:
      "Read CI for a branch or commit ref (e.g. 'dev'). Returns {sha, state, failing:[{name,conclusion,detailsUrl}], pending:[{name,status}]}. state is RED (≥1 check has a terminal-failure conclusion: failure/timed_out/startup_failure/action_required), PENDING (none failed but some still running), or GREEN (all completed, none failed). Kody's own job check-runs (run/kody/agent-responsibility-tick/…) are excluded by default. This reads the commit's authoritative check-runs — use it instead of guessing CI health from a run list.",
    inputSchema: {
      ref: z.string().min(1).describe("Branch name or commit SHA to read CI for (e.g. 'dev')."),
      ignoreNames: z.array(z.string()).optional().describe("Check names to exclude (default: Kody's own job names)."),
    },
    handler: async (args) => {
      const ref = String(args.ref ?? "")
      const ignoreNames = Array.isArray(args.ignoreNames) ? (args.ignoreNames as string[]) : DEFAULT_IGNORE_CHECKS
      const result = readCheckRuns(opts.repoSlug, ref, ignoreNames)
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    },
  }

  const readThreadTool: AgentResponsibilityToolDefinition = {
    name: "read_thread",
    description:
      "Read an issue or PR's recent comments + labels + title/state. Returns {number, title, state, labels:[...], comments:[{author, createdAt, body}]} (newest last, body truncated). Use this to read a verdict a dispatched check posted back — e.g. qa-engineer's report or ui-review's PASS/CONCERNS/FAIL — on a later tick. Read-only; works for both issues AND PRs.",
    inputSchema: {
      number: z.number().int().positive().describe("Issue or PR number to read."),
      limit: z.number().int().positive().optional().describe("Max recent comments to return (default 10)."),
    },
    handler: async (args) => {
      const number = Number(args.number)
      const limit = args.limit ? Number(args.limit) : 10
      const result = readThread(opts.repoSlug, number, limit)
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    },
  }

  const ensureIssueTool: AgentResponsibilityToolDefinition = {
    name: "ensure_issue",
    description:
      "Idempotently ensure ONE open tracking issue exists for `key`. Searches OPEN issues (issues API, not the laggy search index) for `key`'s hidden marker; if found, returns {created:false, number} and creates NOTHING; otherwise creates the issue (title + body, marker appended) and returns {created:true, number}. This is the anti-duplication primitive: use one stable `key` per recurring finding so re-ticks reuse the same issue. Only take follow-up actions (dispatch/comment) when created===true.",
    inputSchema: {
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
          "Issue body markdown (used only on first creation). Include the operator mention verbatim if the agentResponsibility body has one.",
        ),
    },
    handler: async (args) => {
      const key = String(args.key ?? "")
      const title = String(args.title ?? "")
      const body = String(args.body ?? "")
      const result = ensureIssue(opts.repoSlug, key, title, body)
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    },
  }

  const ensureCommentTool: AgentResponsibilityToolDefinition = {
    name: "ensure_comment",
    description:
      "Idempotently post ONE comment on an issue for `key`. If a comment carrying `key`'s marker already exists on the issue, returns {posted:false}; otherwise posts the comment (marker appended) and returns {posted:true}. Use for a notify/audit comment that must appear exactly once.",
    inputSchema: {
      issue: z.number().int().positive().describe("Issue number to comment on."),
      key: z.string().min(1).describe("Stable dedup identity for this comment (e.g. 'dev-ci-red:dispatched')."),
      body: z.string().min(1).describe("Comment body markdown."),
    },
    handler: async (args) => {
      const issue = Number(args.issue)
      const key = String(args.key ?? "")
      const body = String(args.body ?? "")
      const result = ensureComment(opts.repoSlug, issue, key, body)
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    },
  }

  const dispatchTool: AgentResponsibilityToolDefinition = {
    name: "dispatch_workflow",
    description:
      "Dispatch a kody.yml workflow_dispatch run for a agentResponsibility action against an issue (the cross-run bot→engine path; a bot `@kody` comment would be dropped). E.g. dispatch_workflow({agentResponsibility:'run', issueNumber:<n>}) opens a fix PR from a tracking issue. Returns {ok} or {ok:false,error}.",
    inputSchema: {
      agentResponsibility: z.string().min(1).optional().describe("AgentResponsibility action to run (e.g. 'run')."),
      agentAction: z.string().min(1).optional().describe("Deprecated alias for agentResponsibility."),
      issueNumber: z.number().int().positive().describe("Issue (or PR) number forwarded as issue_number."),
    },
    handler: async (args) => {
      const agentResponsibility = String(args.agentResponsibility ?? args.agentAction ?? "")
      const issueNumber = Number(args.issueNumber)
      if (
        isDispatchGated(
          agentResponsibility,
          readAgentResponsibilityTrustMode(opts.state, opts.repoSlug, opts.agentResponsibilitySlug),
        )
      ) {
        return { content: [{ type: "text", text: trustRefusal(opts.agentResponsibilitySlug) }] }
      }
      const result = dispatchWorkflow(workflowFile, agentResponsibility, issueNumber)
      const text = result.ok
        ? `Dispatched agentResponsibility \`${agentResponsibility}\` on #${issueNumber} via workflow_dispatch.`
        : `Dispatch failed for agentResponsibility \`${agentResponsibility}\` on #${issueNumber}: ${result.error}`
      return { content: [{ type: "text", text }] }
    },
  }

  return [
    listTool,
    syncTool,
    fixCiTool,
    resolveTool,
    recommendTool,
    ledgerTool,
    checkRunsTool,
    readThreadTool,
    ensureIssueTool,
    ensureCommentTool,
    dispatchTool,
  ]
}

/**
 * Build the in-process MCP server exposing agentResponsibility primitives. The tool palette
 * intentionally favors high-level intents (sync_pr, fix_ci_pr) over low-level
 * primitives (gh, http) so the LLM can't compose its way out of the lockdown.
 */
export function buildAgentResponsibilityMcpServer(opts: AgentResponsibilityMcpOptions): AgentResponsibilityMcpHandle {
  const definitions = agentResponsibilityToolDefinitions(opts)

  const tools = definitions.map((def) =>
    tool(def.name, def.description, def.inputSchema as Parameters<typeof tool>[2], async (args) =>
      def.handler(args as Record<string, unknown>),
    ),
  )

  const server = createSdkMcpServer({
    name: "kody-agentResponsibility",
    version: "0.1.0",
    tools,
  })

  return { server }
}

/** Set of MCP tool names this server exposes — for allowedTools wiring. */
export const AGENT_RESPONSIBILITY_MCP_TOOL_NAMES = [
  "list_prs_to_repair",
  "sync_pr",
  "fix_ci_pr",
  "resolve_pr",
  "recommend_to_operator",
  "read_ledger",
  "read_check_runs",
  "read_thread",
  "ensure_issue",
  "ensure_comment",
  "dispatch_workflow",
] as const
