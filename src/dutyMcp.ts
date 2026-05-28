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

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
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

function dispatchVerb(workflowFile: string, executable: string, prNumber: number): { ok: true } | { ok: false; error: string } {
  try {
    gh([
      "workflow",
      "run",
      workflowFile,
      "-f",
      `executable=${executable}`,
      "-f",
      `issue_number=${prNumber}`,
    ])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function postRecommendation(
  prNumber: number,
  mention: string,
  message: string,
): { ok: true } | { ok: false; error: string } {
  const body = mention ? `${mention} ${message}` : message
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
    const raw = gh([
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      label,
      "--limit",
      "5",
      "--json",
      "number,body",
    ])
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

/**
 * Build the in-process MCP server exposing duty primitives. The tool palette
 * intentionally favors high-level intents (sync_pr, fix_ci_pr) over low-level
 * primitives (gh, http) so the LLM can't compose its way out of the lockdown.
 */
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
      body: z.string().min(1).describe("Comment body (markdown). Do not include the operator mention — the engine prepends it."),
    },
    async (args) => {
      const result = postRecommendation(args.pr, opts.operatorMention, args.body)
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
      label: z.string().min(1).describe("GitHub issue label that identifies the manifest issue (e.g. 'kody:cto-decisions')."),
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

  const server = createSdkMcpServer({
    name: "kody-duty",
    version: "0.1.0",
    tools: [listTool, syncTool, fixCiTool, resolveTool, recommendTool, ledgerTool],
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
] as const
