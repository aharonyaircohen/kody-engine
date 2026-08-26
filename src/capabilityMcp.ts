/**
 * In-process MCP server exposing typed "capability primitives" to the capability-tick agent.
 *
 * Why this exists: capabilities used to be markdown bodies with `Bash` + `gh` access.
 * That escape hatch let any capability post `@kody <verb>` comments that the engine's
 * webhook receiver silently drops to prevent self-dispatch loops — capabilities
 * therefore "succeeded" while their dispatched verbs never ran. The fix isn't
 * another guard or per-capability rewrite; it's removing the escape hatch entirely.
 *
 * A capability declares the tools it needs (`tools: [...]` metadata); the engine
 * loads ONLY those (plus `submit_state`) and revokes `Bash`/`Read`. The capability
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
 * whole structured world the capability needs to make its decision.
 *
 * Transport: tool definitions are extracted into `capabilityToolDefinitions` so the
 * same handlers power both the in-process MCP server (via claude-agent-sdk)
 * and the HTTP MCP server (via @modelcontextprotocol/sdk).
 */

import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk"
import type { ZodRawShape } from "zod"
import { z } from "zod"
import { DASHBOARD_CMS_MCP_TOOL_NAMES, dashboardCmsToolDefinitions } from "./dashboardCmsMcp.js"
import { gh } from "./issue.js"
import { getProfileInputs, resolveCapabilityAction } from "./registry.js"
import { createStateBackendFromEnv } from "./state-backend.js"
import { parseTrustMode, type TrustMode } from "./trustPolicy.js"

export interface CapabilityMcpHandle {
  /** Config object to drop into `mcpServers["kody-capability"]`. */
  server: McpSdkServerConfigWithInstance
}

interface CapabilityMcpOptions {
  /** Repo slug "owner/name" — read from kody.config.json/runtime context. */
  repoSlug: string
  /**
   * The operator @-mention prefix (e.g. "@aguyaharonyair") substituted into
   * recommend_to_operator comments. Empty string when the capability's `mentions:`
   * metadata is blank — the comment is then unmentioned (still posted).
   */
  operatorMention: string
  /** Workflow file to dispatch (default "kody.yml"). */
  workflowFile?: string
  /** Consumer agency branch used for child workflow dispatches. */
  defaultBranch?: string
  /**
   * Slug of the capability currently running (`ctx.data.jobSlug`). Stamped onto every
   * `recommend_to_operator` comment as `<!-- kody-capability: <slug> -->` so the
   * dashboard keys trust per CAPABILITY, not per agent. Omitted → no stamp (the
   * dashboard then falls back to the agent slug).
   */
  capabilitySlug?: string
  /** Exact tools to expose from the in-process MCP server. Omitted for HTTP transport. */
  allowedToolNames?: readonly string[]
}

// ────────────────────────────────────────────────────────────────────────────
// Tool definition shape (transport-agnostic).
// ────────────────────────────────────────────────────────────────────────────

export type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}>

export interface CapabilityToolDefinition {
  name: string
  description: string
  inputSchema: ZodRawShape
  handler: ToolHandler
}

export function selectCapabilityToolDefinitions(
  definitions: CapabilityToolDefinition[],
  allowedToolNames?: readonly string[],
): CapabilityToolDefinition[] {
  if (!allowedToolNames) return definitions
  const available = new Set(definitions.map((definition) => definition.name))
  const unknown = allowedToolNames.filter((name) => !available.has(name))
  if (unknown.length > 0) throw new Error(`Unknown capability MCP tools: ${unknown.join(", ")}`)
  const allowed = new Set(allowedToolNames)
  return definitions.filter((definition) => allowed.has(definition.name))
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
  repoSlug: string,
  capability: string,
  prNumber: number,
): { ok: true; runId?: number } | { ok: false; error: string } {
  return dispatchWorkflow(workflowFile, capability, prNumber, repoSlug)
}

type RecommendationPostResult = { ok: true; posted: boolean } | { ok: false; error: string }

function capabilityMarker(slug: string): string {
  return `<!-- kody-capability: ${slug} -->`
}

function normalizeRecommendationIntent(body: string): string | null {
  const marker = body.match(/<!--\s*kody-intent:\s*([\s\S]*?)-->/i)
  if (marker?.[1]) return marker[1].trim().replace(/\s+/g, " ").toLowerCase()

  const legacy = body.match(/(?:^|\n)\s*(?:kody-cmd:\s*|@kody\s+)([a-z][\w-]*(?:\s+--pr\s+\d+)?)/i)
  if (legacy?.[1]) return legacy[1].trim().replace(/\s+/g, " ").toLowerCase()

  return null
}

function containsImplementationKodyCommand(body: string): boolean {
  return /@kody\b/i.test(body) || /\bkody-cmd\s*:/i.test(body)
}

function recommendationAlreadyExists(
  repoSlug: string,
  prNumber: number,
  body: string,
  capabilitySlug?: string,
): boolean {
  const requestedIntent = normalizeRecommendationIntent(body)
  const requestedText = body.trim().replace(/\s+/g, " ")
  const raw = gh(["issue", "view", String(prNumber), "-R", repoSlug, "--json", "comments"])
  const parsed = JSON.parse(raw) as { comments?: Array<{ body?: string }> }

  return (parsed.comments ?? []).some((comment) => {
    const existing = comment.body ?? ""
    if (capabilitySlug && !existing.includes(capabilityMarker(capabilitySlug))) return false

    const existingIntent = normalizeRecommendationIntent(existing)
    if (requestedIntent && existingIntent) return requestedIntent === existingIntent

    // A capability recommendation is one operator ask per PR. If an older comment
    // lacks an intent marker, do not create a second ask for the same capability.
    if (capabilitySlug && requestedIntent) return true

    return existing.trim().replace(/\s+/g, " ").includes(requestedText)
  })
}

function postRecommendation(
  repoSlug: string,
  prNumber: number,
  mention: string,
  message: string,
  capabilitySlug?: string,
): RecommendationPostResult {
  if (containsImplementationKodyCommand(message)) {
    return {
      ok: false,
      error: "recommendation body contains implementation Kody command text; use inert kody-intent metadata",
    }
  }

  const mentioned = mention ? `${mention} ${message}` : message
  const body = capabilitySlug ? `${mentioned}\n\n${capabilityMarker(capabilitySlug)}` : mentioned
  try {
    if (recommendationAlreadyExists(repoSlug, prNumber, body, capabilitySlug)) {
      return { ok: true, posted: false }
    }
    gh(["issue", "comment", String(prNumber), "-R", repoSlug, "--body-file", "-"], { input: body })
    return { ok: true, posted: true }
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
// Capability trust gate.
// ---------------------------------------------------------------------------

export type CapabilityTrustMode = TrustMode

export function parseCapabilityTrustMode(rawJson: string, capabilitySlug: string): CapabilityTrustMode {
  return parseTrustMode(rawJson, { kind: "capability", id: capabilitySlug })
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
const DEFAULT_IGNORE_CHECKS = ["run", "kody", "capability-tick", "agent-ask", "chat"]

export interface CheckRunsResult {
  sha: string
  state: "RED" | "PENDING" | "GREEN"
  failing: Array<{ name: string; conclusion: string; detailsUrl: string }>
  pending: Array<{ name: string; status: string }>
}

export function readCheckRuns(repoSlug: string, ref: string, ignoreNames: string[]): CheckRunsResult {
  const ghOptions = { preferRepoToken: true }
  const sha = gh(["api", `repos/${repoSlug}/commits/${ref}`, "--jq", ".sha"], ghOptions).trim()
  const raw = gh(
    [
      "api",
      `repos/${repoSlug}/commits/${sha}/check-runs`,
      "--paginate",
      "--jq",
      ".check_runs[] | {name, status, conclusion, details_url}",
    ],
    ghOptions,
  )
  let rawStatuses = ""
  try {
    rawStatuses = gh(
      ["api", `repos/${repoSlug}/commits/${sha}/status`, "--jq", ".statuses[] | {context, state, target_url}"],
      ghOptions,
    )
  } catch {
    // Some tokens can read check-runs but not legacy commit statuses. Keep the
    // check-run result usable instead of failing the whole health read.
  }
  const ignore = new Set(ignoreNames.map((n) => n.toLowerCase()))
  const checks = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { name: string; status: string; conclusion: string | null; details_url: string })
    .filter((c) => !ignore.has(String(c.name).toLowerCase()))
  const statuses = rawStatuses
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { context: string; state: string; target_url: string | null })
    .filter((status) => !ignore.has(String(status.context).toLowerCase()))
  const failing: CheckRunsResult["failing"] = checks
    .filter((c) => CHECK_FAIL_CONCLUSIONS.has(String(c.conclusion ?? "").toUpperCase()))
    .map((c) => ({ name: c.name, conclusion: String(c.conclusion), detailsUrl: c.details_url }))
  failing.push(
    ...statuses
      .filter((status) => ["error", "failure"].includes(String(status.state).toLowerCase()))
      .map((status) => ({
        name: status.context,
        conclusion: status.state,
        detailsUrl: status.target_url ?? "",
      })),
  )
  const pending: CheckRunsResult["pending"] = checks
    .filter((c) => String(c.status).toLowerCase() !== "completed")
    .map((c) => ({ name: c.name, status: c.status }))
  pending.push(
    ...statuses
      .filter((status) => String(status.state).toLowerCase() === "pending")
      .map((status) => ({ name: status.context, status: status.state })),
  )
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
  capability: string,
  issueNumber: number | undefined,
  repoSlug?: string,
  ref?: string,
): { ok: true; runId?: number } | { ok: false; error: string } {
  const expected = expectedDispatchTarget(capability)
  if (repoSlug && expected && issueNumber) {
    const target = readDispatchTargetKind(repoSlug, issueNumber)
    if (!target.ok) return target
    if (expected === "issue" && target.kind === "pr") {
      return {
        ok: false,
        error: `refusing to dispatch ${capability} on PR #${issueNumber}; dispatch the source issue or use a PR action`,
      }
    }
    if (expected === "pr" && target.kind === "issue") {
      return {
        ok: false,
        error: `refusing to dispatch ${capability} on issue #${issueNumber}; expected a PR target`,
      }
    }
  }

  try {
    const output = gh([
      "workflow",
      "run",
      workflowFile,
      ...(ref ? ["--ref", ref] : []),
      "-f",
      `capability=${capability}`,
      ...(issueNumber ? ["-f", `issue_number=${issueNumber}`] : []),
    ])
    const runId = Number(output.match(/actions\/runs\/(\d+)/)?.[1])
    return Number.isFinite(runId) && runId > 0 ? { ok: true, runId } : { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function startCapability(
  workflowFile: string,
  name: string,
  issue: number | undefined,
  repoSlug?: string,
  ref?: string,
): { ok: true; runId?: number } | { ok: false; error: string } {
  const acceptsIssue = capabilityAcceptsIssue(name)
  const forwardedIssue = acceptsIssue === false ? undefined : issue
  return dispatchWorkflow(workflowFile, name, forwardedIssue, repoSlug, ref)
}

function capabilityAcceptsIssue(capability: string): boolean | null {
  const route = resolveCapabilityAction(capability)
  if (!route) return null
  const inputs = getProfileInputs(route.implementation) ?? []
  return inputs.some((input) => input.name === "issue" || input.name === "pr")
}

function expectedDispatchTarget(capability: string): "issue" | "pr" | null {
  const route = resolveCapabilityAction(capability)
  if (!route) return null
  const inputs = getProfileInputs(route.implementation)
  const numeric = inputs?.find((input) => input.type === "int" && input.required)
  if (numeric?.name === "issue") return "issue"
  if (numeric?.name === "pr") return "pr"
  return null
}

function readDispatchTargetKind(
  repoSlug: string,
  issueNumber: number,
): { ok: true; kind: "issue" | "pr" } | { ok: false; error: string } {
  try {
    const raw = gh(["api", `repos/${repoSlug}/issues/${issueNumber}`])
    const parsed = JSON.parse(raw) as { pull_request?: unknown }
    return { ok: true, kind: parsed.pull_request ? "pr" : "issue" }
  } catch (err) {
    return {
      ok: false,
      error: `could not verify target #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Trust gate for dispatch tools.
// ---------------------------------------------------------------------------

export function isDispatchGated(capability: string | null | undefined, mode: CapabilityTrustMode): boolean {
  void capability
  void mode
  return false
}

function assertCmsWriteAllowed(opts: CapabilityMcpOptions): string | null {
  void opts
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// Tool definitions (transport-agnostic).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build all capability tool definitions. Used by both adapters.
 */
export function capabilityToolDefinitions(opts: CapabilityMcpOptions): CapabilityToolDefinition[] {
  const workflowFile = opts.workflowFile ?? "kody.yml"

  const listTool: CapabilityToolDefinition = {
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

  const makeDispatch = (verb: "sync" | "fix-ci" | "resolve", describe: string): CapabilityToolDefinition => ({
    name: `${verb.replace("-", "_")}_pr`,
    description: describe,
    inputSchema: {
      pr: z.number().int().positive().describe("PR number to repair."),
    },
    handler: async (args) => {
      const pr = Number(args.pr)
      const result = dispatchVerb(workflowFile, opts.repoSlug, verb, pr)
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

  const recommendTool: CapabilityToolDefinition = {
    name: "recommend_to_operator",
    description:
      "Post ONE comment on a PR with the operator @-mention prepended. Use this when the operator should confirm or review something via the dashboard inbox. The mention handle is substituted from kody.config.json `github.operators` — do not type it yourself.",
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
      const result = postRecommendation(opts.repoSlug, pr, opts.operatorMention, body, opts.capabilitySlug)
      const text = result.ok
        ? result.posted
          ? `Recommendation posted on PR #${pr}.`
          : `Recommendation already exists on PR #${pr}; skipped.`
        : `Recommendation failed on PR #${pr}: ${result.error}`
      return { content: [{ type: "text", text }] }
    },
  }

  const ledgerTool: CapabilityToolDefinition = {
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

  const checkRunsTool: CapabilityToolDefinition = {
    name: "read_check_runs",
    description:
      "Read CI for a branch or commit ref (e.g. 'dev'). Returns {sha, state, failing:[{name,conclusion,detailsUrl}], pending:[{name,status}]}. state is RED (≥1 check has a terminal-failure conclusion: failure/timed_out/startup_failure/action_required), PENDING (none failed but some still running), or GREEN (all completed, none failed). Kody's own job check-runs (run/kody/capability-tick/…) are excluded by default. This reads the commit's authoritative check-runs — use it instead of guessing CI health from a run list.",
    inputSchema: {
      ref: z
        .string()
        .min(1)
        .optional()
        .describe("Branch name, commit SHA, or 'default' for the configured agency branch."),
      ignoreNames: z.array(z.string()).optional().describe("Check names to exclude (default: Kody's own job names)."),
    },
    handler: async (args) => {
      const requestedRef = String(args.ref ?? "default")
      const workflowRef = process.env.GITHUB_REF_NAME?.trim()
      const ref = requestedRef === "default" ? workflowRef || opts.defaultBranch || "main" : requestedRef
      const ignoreNames = Array.isArray(args.ignoreNames) ? (args.ignoreNames as string[]) : DEFAULT_IGNORE_CHECKS
      const result = readCheckRuns(opts.repoSlug, ref, ignoreNames)
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    },
  }

  const readThreadTool: CapabilityToolDefinition = {
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

  const ensureIssueTool: CapabilityToolDefinition = {
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
          "Issue body markdown (used only on first creation). Include the operator mention verbatim if the capability body has one.",
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

  const ensureCommentTool: CapabilityToolDefinition = {
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

  const startCapabilityTool: CapabilityToolDefinition = {
    name: "start_capability",
    description:
      "Start a known Kody capability on an issue or PR through workflow_dispatch. Use this instead of shelling out to `gh workflow run` or posting bot-authored `@kody` command comments. E.g. start_capability({name:'qa-engineer', issue:<n>}). Returns {ok} or {ok:false,error}.",
    inputSchema: {
      name: z.string().min(1).describe("Capability action to start (e.g. 'qa-engineer', 'run', 'sync')."),
      issue: z.number().int().positive().optional().describe("Issue or PR number forwarded as issue_number."),
      issueNumber: z.number().int().positive().optional().describe("Deprecated alias for issue."),
    },
    handler: async (args) => {
      const name = String(args.name ?? "")
      const rawIssue = args.issue ?? args.issueNumber
      const issue = rawIssue == null ? undefined : Number(rawIssue)
      if (issue !== undefined && (!Number.isFinite(issue) || issue <= 0)) {
        return { content: [{ type: "text", text: "Start failed: `issue` must be a positive number when provided." }] }
      }
      const result = startCapability(workflowFile, name, issue, opts.repoSlug, opts.defaultBranch)
      const text = JSON.stringify(result)
      return { content: [{ type: "text", text }] }
    },
  }

  const readLatestReportTool: CapabilityToolDefinition = {
    name: "read_latest_report",
    description:
      "Read the newest persisted Kody Report for this repository. Optionally restrict to one stable report slug or reports newer than an ISO timestamp. Returns the Report body and metadata; use it as evidence before deciding whether work is needed.",
    inputSchema: {
      slug: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/)
        .optional(),
      since: z.string().datetime().optional(),
    },
    handler: async (args) => {
      const slug = typeof args.slug === "string" ? args.slug : undefined
      const since = typeof args.since === "string" ? args.since : undefined
      const reports = await createStateBackendFromEnv().listReports(opts.repoSlug)
      const report = reports
        .filter((candidate) => (!slug || candidate.slug === slug) && (!since || candidate.updatedAt > since))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              report
                ? {
                    found: true,
                    slug: report.slug,
                    runId: report.runId,
                    title: report.title,
                    body: report.body,
                    meta: report.meta,
                    updatedAt: report.updatedAt,
                  }
                : { found: false },
              null,
              2,
            ),
          },
        ],
      }
    },
  }

  const reconcileTodoTool: CapabilityToolDefinition = {
    name: "reconcile_todo",
    description:
      "Idempotently create, update, close, or reopen one canonical repository Todo for a recurring problem. The stable slug and item id prevent duplicates. Repeating the same state is a no-op; unrelated items in an existing Todo are preserved.",
    inputSchema: {
      slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      itemId: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/)
        .optional(),
      title: z.string().min(1).max(160),
      description: z.string().max(20_000).optional(),
      status: z.enum(["open", "resolved"]),
      reportSlug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
      reportRunId: z.string().max(160).optional(),
      evidence: z.string().max(20_000).optional(),
    },
    handler: async (args) => {
      const slug = String(args.slug)
      const itemId = typeof args.itemId === "string" ? args.itemId : "finding"
      const title = String(args.title).trim()
      const description = typeof args.description === "string" ? args.description.trim() : ""
      const status = args.status === "resolved" ? "resolved" : "open"
      const reportSlug = String(args.reportSlug)
      const reportRunId = typeof args.reportRunId === "string" ? args.reportRunId : undefined
      const evidence = typeof args.evidence === "string" ? args.evidence.trim() : ""
      const backend = createStateBackendFromEnv()
      const now = new Date().toISOString()
      const completed = status === "resolved"
      let lastError: unknown = new Error(`Todo ${slug}/${itemId} was not visible after reconciliation`)

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const existing = await backend.getRepoDoc(opts.repoSlug, `todo:${slug}`)
          const current =
            existing?.doc && typeof existing.doc === "object" && !Array.isArray(existing.doc)
              ? (existing.doc as Record<string, unknown>)
              : {}
          const currentItems = Array.isArray(current.items)
            ? current.items.filter((item): item is Record<string, unknown> =>
                Boolean(item && typeof item === "object" && !Array.isArray(item)),
              )
            : []
          const previous = currentItems.find((item) => item.id === itemId)
          const previousMeta =
            previous?.meta && typeof previous.meta === "object" && !Array.isArray(previous.meta)
              ? (previous.meta as Record<string, unknown>)
              : {}
          const unchanged = Boolean(
            previous &&
              previous.completed === completed &&
              previous.title === title &&
              String(previous.body ?? "") === evidence &&
              previousMeta.reportSlug === reportSlug,
          )
          if (unchanged) {
            return {
              content: [{ type: "text", text: JSON.stringify({ changed: false, verified: true, slug, status }) }],
            }
          }
          const nextItem = {
            id: itemId,
            title,
            body: evidence,
            assignee: null,
            completed,
            createdAt: typeof previous?.createdAt === "string" ? previous.createdAt : now,
            completedAt: completed ? now : null,
            meta: {
              ...previousMeta,
              source: "live-agent",
              reportSlug,
              ...(reportRunId ? { reportRunId } : {}),
              status,
            },
          }
          const items = previous
            ? currentItems.map((item) => (item.id === itemId ? nextItem : item))
            : [...currentItems, nextItem]
          const doc = {
            ...current,
            version: 1,
            title,
            description,
            createdAt: typeof current.createdAt === "string" ? current.createdAt : now,
            items,
          }
          await backend.saveRepoDoc(opts.repoSlug, `todo:${slug}`, doc, existing?.updatedAt)

          const saved = await backend.getRepoDoc(opts.repoSlug, `todo:${slug}`)
          const savedItems =
            saved?.doc &&
            typeof saved.doc === "object" &&
            !Array.isArray(saved.doc) &&
            Array.isArray((saved.doc as Record<string, unknown>).items)
              ? ((saved.doc as Record<string, unknown>).items as unknown[])
              : []
          const savedItem = savedItems.find((item): item is Record<string, unknown> =>
            Boolean(
              item &&
                typeof item === "object" &&
                !Array.isArray(item) &&
                (item as Record<string, unknown>).id === itemId,
            ),
          )
          const savedMeta =
            savedItem?.meta && typeof savedItem.meta === "object" && !Array.isArray(savedItem.meta)
              ? (savedItem.meta as Record<string, unknown>)
              : {}
          if (
            savedItem &&
            savedItem.completed === completed &&
            savedItem.title === title &&
            String(savedItem.body ?? "") === evidence &&
            savedMeta.reportSlug === reportSlug
          ) {
            return {
              content: [{ type: "text", text: JSON.stringify({ changed: true, verified: true, slug, status }) }],
            }
          }
          lastError = new Error(`Todo ${slug}/${itemId} was not visible after reconciliation attempt ${attempt + 1}`)
        } catch (error) {
          lastError = error
        }
      }

      throw lastError
    },
  }

  const cmsTools = dashboardCmsToolDefinitions({
    repoSlug: opts.repoSlug,
    assertWriteAllowed: () => assertCmsWriteAllowed(opts),
  })

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
    startCapabilityTool,
    readLatestReportTool,
    reconcileTodoTool,
    ...cmsTools,
  ]
}

/**
 * Build the in-process MCP server exposing capability primitives. The tool palette
 * intentionally favors high-level intents (sync_pr, fix_ci_pr) over low-level
 * primitives (gh, http) so the LLM can't compose its way out of the lockdown.
 */
export function buildCapabilityMcpServer(opts: CapabilityMcpOptions): CapabilityMcpHandle {
  const definitions = selectCapabilityToolDefinitions(capabilityToolDefinitions(opts), opts.allowedToolNames)

  const tools = definitions.map((def) =>
    tool(def.name, def.description, def.inputSchema as Parameters<typeof tool>[2], async (args) =>
      def.handler(args as Record<string, unknown>),
    ),
  )

  const server = createSdkMcpServer({
    name: "kody-capability",
    version: "0.1.0",
    tools,
  })

  return { server }
}

/** Set of MCP tool names this server exposes — for allowedTools wiring. */
export const CAPABILITY_MCP_TOOL_NAMES = [
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
  "start_capability",
  "read_latest_report",
  "reconcile_todo",
  ...DASHBOARD_CMS_MCP_TOOL_NAMES,
] as const
