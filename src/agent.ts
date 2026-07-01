import * as fs from "node:fs"
import * as path from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { ensureStableClaudeBinary } from "./claudeBinary.js"
import {
  getAnthropicApiKeyOrDummy,
  type KodyConfig,
  type ProviderModel,
  REASONING_BUDGETS,
  type ReasoningEffort,
} from "./config.js"
import { renderEvent, type SdkMessageLike } from "./format.js"
import { agentRunDir } from "./runtimePaths.js"

export interface AgentTokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

/**
 * Structured outcome kind for an agent run. Lets the container loop and
 * postflight scripts route on the reason for failure instead of treating
 * every non-success as the same. The legacy two-way `outcome` string is
 * kept on AgentResult for backward compatibility with existing scripts
 * (parseAgentResult, postReviewResult, openQaIssue, createQaGoal).
 */
export type AgentOutcomeKind =
  | "ok" // result subtype === "success"
  | "stalled" // per-turn watchdog fired
  | "out_of_turns" // SDK reported max-turns hit
  | "rate_limit" // SDK reported rate-limit / 429
  | "tool_error" // SDK reported a tool execution failure
  | "model_error" // exception thrown inside the SDK call
  | "generic_failed" // any other non-success result subtype

export interface AgentResult {
  outcome: "completed" | "failed"
  /**
   * Structured kind — preferred for new routing decisions. Optional so
   * existing test fixtures that only mock the legacy `outcome` string
   * still compile; runAgent itself always populates it.
   */
  outcomeKind?: AgentOutcomeKind
  finalText: string
  /**
   * State the agent submitted via the in-process `submit_state` tool
   * (capability-tick only, when `enableSubmitTool` is set). Preferred over the
   * legacy fenced `kody-job-next-state` block when present. Undefined when
   * the tool wasn't enabled or the agent never called it.
   */
  submittedState?: { cursor: string; data: Record<string, unknown>; done: boolean }
  error?: string
  ndjsonPath: string
  /** Wall-clock duration of the agent invocation, in milliseconds. */
  durationMs?: number
  /** Cumulative token usage across all `result` messages. */
  tokens?: AgentTokenUsage
  /** Number of SDK messages observed (proxy for turn count). */
  messageCount?: number
}

/** Map an SDK result subtype string into a structured outcome kind. */
function classifySubtype(subtype: string | undefined): AgentOutcomeKind {
  if (!subtype) return "generic_failed"
  const lower = subtype.toLowerCase()
  if (lower === "success") return "ok"
  if (lower.includes("max_turns") || lower.includes("max-turns")) return "out_of_turns"
  if (lower.includes("rate_limit") || lower.includes("rate-limit")) return "rate_limit"
  if (lower.includes("tool")) return "tool_error"
  if (lower.includes("error")) return "model_error"
  return "generic_failed"
}

function isClaudeLoginRequiredText(text: string): boolean {
  const normalized = text.toLowerCase()
  return normalized.includes("not logged in") && normalized.includes("/login")
}

export interface AgentOptions {
  prompt: string
  model: ProviderModel
  cwd: string
  litellmUrl?: string | null
  verbose?: boolean
  quiet?: boolean
  ndjsonDir?: string
  /** Override the default allowed tool list (e.g. read-only for review). */
  allowedToolsOverride?: string[]
  /** Override the default permissionMode (e.g. "default" for read-only flows). */
  permissionModeOverride?: "default" | "acceptEdits" | "plan" | "bypassPermissions"
  /**
   * MCP server specs declared by the profile (claudeCode.mcpServers).
   * Transformed to the SDK's record shape (keyed by server name) before
   * being forwarded to `query()`.
   */
  mcpServers?: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }>
  /**
   * Absolute paths to plugin directories to load. Each is passed to the
   * SDK's `plugins` option as `{ type: 'local', path }`. Kody uses this
   * for both external plugins (from profile.claudeCode.plugins) and the
   * synthetic plugin built by the buildSyntheticPlugin preflight.
   */
  pluginPaths?: string[]
  /**
   * Subagents to register for the Agent/Task tool, keyed by name. Passed
   * straight to the SDK's `agents` query option — the reliable path for
   * custom subagents (the plugin-manifest route does not register them).
   */
  agents?: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>
  /** Hard cap on agent turns. null/undefined = SDK default (unbounded). */
  maxTurns?: number | null
  /**
   * Thinking level. Maps to the SDK's `maxThinkingTokens` (Anthropic
   * extended thinking). When set, overrides the explicit
   * `maxThinkingTokens` field if both are provided — this is the
   * preferred surface. Unset / `"off"` means no thinking block is sent
   * to the model, which is the cheapest path (no reasoning preamble,
   * no thinking-token spend).
   *
   * Resolution: `runChatTurn` reads from CLI flag → env var → config.
   * Direct callers of `runAgent` (tests, executables) can set either
   * field directly; `reasoningEffort` wins when both are set.
   */
  reasoningEffort?: ReasoningEffort | null
  /** Extended-thinking token budget. null/undefined = SDK default. */
  maxThinkingTokens?: number | null
  /**
   * Watchdog: abort the agent if no SDK message arrives within this window.
   * Catches stalls (hung tool calls, network deadlock) that maxTurns can't
   * see. Default: 300_000 (5 min). Override with `KODY_TURN_TIMEOUT_SEC`.
   * Pass 0 or a negative number to disable the watchdog.
   */
  maxTurnTimeoutMs?: number | null
  /** Text appended to Claude Code's baseline system prompt. */
  systemPromptAppend?: string | null
  /**
   * When true, set `systemPrompt.excludeDynamicSections: true` so the
   * Claude Code preset becomes byte-identical across runs and is
   * eligible for cross-process prompt caching. The SDK strips per-user
   * dynamic sections (cwd, git status, auto-memory) from the preset
   * and re-injects them as the first user message so the agent does
   * not lose context. Forward-compatible: silently ignored if the SDK
   * lacks the option. Default false.
   */
  cacheable?: boolean
  /**
   * Phase 3 opt-in: build an in-process MCP server exposing a `verify`
   * tool the agent can call to run typecheck/lint/tests and iterate
   * inside one session. Requires `verifyConfig` (the project config)
   * to be set. Default false.
   */
  enableVerifyTool?: boolean
  /**
   * Opt-in: build an in-process MCP server exposing a `submit_state` tool the
   * agent calls to persist its next state (used by capability-tick instead of relying
   * on a trailing fenced block). Default false.
   */
  enableSubmitTool?: boolean
  /**
   * Opt-in (capability-tick locked-toolbox mode): build an in-process MCP server
   * exposing typed capability primitives (list_prs_to_repair, sync_pr, fix_ci_pr,
   * resolve_pr, recommend_to_operator, read_ledger). Triggered by a capability
   * declaring `tools:` metadata — `loadJobFromFile` then revokes Bash/Read
   * and locks `allowedTools` to only the capability's declared MCP tools (plus
   * `submit_state`). Default false.
   */
  enableCapabilityTool?: boolean
  /**
   * Operator @-mention prefix the capability MCP uses for `recommend_to_operator`
   * (e.g. "@aguyaharonyair"). Comes from the capability's `mentions:` metadata.
   * Empty string when the capability declared no operator (comment is still posted,
   * just without a mention). Ignored when `enableCapabilityTool` is false.
   */
  capabilityOperatorMention?: string
  /**
   * Repo slug "owner/name" the capability MCP uses for `gh api compare/...` calls.
   * Falls back from kody.config.json → GITHUB_REPOSITORY. Ignored when
   * `enableCapabilityTool` is false.
   */
  capabilityRepoSlug?: string
  /** Canonical Kody state location used by locked capability tools. */
  capabilityState?: KodyConfig["state"]
  /**
   * Slug of the running capability (`ctx.data.jobSlug`), stamped onto
   * `recommend_to_operator` comments so the dashboard keys trust per capability.
   * Ignored when `enableCapabilityTool` is false.
   */
  capabilitySlug?: string
  /**
   * Opt-in (chat/Brain): expose CMS tools backed by the Dashboard CMS REST API.
   * This keeps CMS data access behind one Dashboard-owned boundary.
   */
  enableDashboardCmsTool?: boolean
  /** Dashboard origin used by the CMS MCP tool. Falls back to env when omitted. */
  cmsDashboardUrl?: string
  /** Repo slug "owner/name" forwarded to Dashboard CMS auth headers. */
  cmsRepoSlug?: string
  /** Dashboard auth token forwarded as x-kody-token. Falls back to env when omitted. */
  cmsToken?: string
  /** Dashboard store repo URL forwarded to CMS routes for adapter loading. */
  cmsStoreRepoUrl?: string
  /** Dashboard store ref forwarded to CMS routes for adapter loading. */
  cmsStoreRef?: string
  /**
   * Opt-in (chat/Brain): build an in-process MCP server exposing a
   * `fetch_repo` tool so the agent can clone and work on repos other than the
   * one it was handed. Requires `reposRoot`; grants the agent read access to
   * `reposRoot` via `additionalDirectories`. Default false.
   */
  enableFetchRepoTool?: boolean
  /** Extra filesystem roots the SDK should grant tool access to. */
  additionalDirectories?: string[]
  /** Where fetch_repo clones live (`<reposRoot>/<owner>/<name>`). */
  reposRoot?: string
  /** GitHub token fetch_repo uses to clone private repos (the user's PAT). */
  repoToken?: string
  /** Max number of verify-tool calls per session. Falls back to default. */
  verifyToolMaxAttempts?: number | null
  /** Config passed to the verify tool's underlying `verifyAllWithRetry` call. */
  verifyConfig?: unknown
  /** Executable name (for event-emission attribution from the verify tool). */
  executableName?: string
  /**
   * Filesystem sources the SDK should auto-load. `"project"` loads
   * `<cwd>/.claude/` (skills, commands, settings.json) and CLAUDE.md;
   * `"local"` loads `<cwd>/.claude/settings.local.json`; `"user"` loads
   * `~/.claude/`. Default: `["project", "local"]` so the target repo's
   * configuration is picked up. Pass `[]` for SDK isolation.
   */
  settingSources?: Array<"user" | "project" | "local">
  /**
   * Per-turn progress callback. Invoked with structured events as the
   * SDK streams messages back from the model. Chat mode wires this to
   * the event sink so the dashboard can render thinking + tool calls
   * live instead of waiting for the final reply. Best-effort — errors
   * inside the callback are swallowed so progress instrumentation can
   * never break the actual agent turn.
   */
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>
  /**
   * Backend-recovery hook, invoked before a connection-error retry so the
   * owner (executor) can restart a crashed model proxy — otherwise the retry
   * just hits the same dead backend. No-op / unset for direct-Anthropic runs.
   */
  ensureBackend?: () => Promise<void>
  /**
   * Pure liveness probe for the model backend (litellm proxy), no side effect.
   * After a session the SDK reports as "success", we call this: if the proxy is
   * dead the model never answered — it crashed mid-request and the SDK emitted
   * a hollow 1-turn / $0 "success". That definitively demotes the run (below),
   * which then restarts the proxy via `ensureBackend` and retries. Unset for
   * direct-Anthropic runs.
   */
  isBackendHealthy?: () => Promise<boolean>
}

/**
 * Structured progress event surfaced from the agent loop as SDK
 * messages arrive. Lossy by design — the consumer (chat-mode sink)
 * picks the fields it needs and ignores the rest.
 */
export type AgentProgressEvent =
  | { kind: "thinking"; thinking: string }
  | { kind: "tool_use"; name: string; input?: Record<string, unknown>; id?: string }
  | { kind: "tool_result"; toolUseId?: string; content: string; isError?: boolean }
  | { kind: "text"; text: string }

const DEFAULT_ALLOWED_TOOLS = ["Bash", "Edit", "Read", "Write", "Glob", "Grep"]
// Default watchdog: 10 min between SDK messages. Tuned for real `run` /
// `fix` stages on production-sized repos where the agent may go silent
// while a multi-minute test suite executes inside Bash. Stages with
// genuinely longer silent windows (full e2e runs, big migrations) can
// override per-profile via claudeCode.maxTurnTimeoutSec, or globally via
// KODY_TURN_TIMEOUT_SEC. An earlier 300s default fired during real
// production runs (#1562) where the watchdog itself became the failure
// cause rather than a stall detector.
const DEFAULT_TURN_TIMEOUT_MS = 600_000

/**
 * Resolve the inter-message watchdog timeout. Precedence:
 *   1. opts.maxTurnTimeoutMs (per-call override; 0 / negative disables)
 *   2. KODY_TURN_TIMEOUT_SEC env var
 *   3. 300_000 ms (5 min) default
 */
function resolveTurnTimeoutMs(opts: AgentOptions): number {
  if (opts.maxTurnTimeoutMs !== undefined && opts.maxTurnTimeoutMs !== null) {
    return opts.maxTurnTimeoutMs > 0 ? opts.maxTurnTimeoutMs : 0
  }
  const envSec = Number(process.env.KODY_TURN_TIMEOUT_SEC)
  if (Number.isFinite(envSec) && envSec > 0) return Math.floor(envSec * 1000)
  if (Number.isFinite(envSec) && envSec <= 0) return 0
  return DEFAULT_TURN_TIMEOUT_MS
}

/** Max times to re-run a session after a transient connection failure. */
const MAX_CONNECTION_RETRIES = 2
/** Base backoff before a connection retry; doubles each attempt. */
const CONNECTION_RETRY_BASE_MS = 2000

/**
 * A transient connectivity failure reaching the model API (or the local
 * litellm proxy). Safe to retry verbatim — nothing reached the model, so the
 * failed turn produced no new side effect.
 */
function isTransientConnectionError(msg: string | undefined): boolean {
  if (!msg) return false
  return /ConnectionRefused|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|socket hang up|Unable to connect to API|fetch failed/i.test(
    msg,
  )
}

/** File-editing tools whose replay could duplicate a durable change. */
const MUTATING_FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
/**
 * `Bash` commands that write durable state. We only block a retry on a clear
 * write verb — reads (gh/git list/view, cat, grep, …) stay retryable so a
 * connection blip mid-run can still recover.
 */
const BASH_WRITE_VERB =
  /\b(git\s+(commit|push|merge|rebase|tag|reset|cherry-pick)|gh\s+(pr|issue|release)\s+(create|comment|edit|close|merge|review|reopen)|gh\s+api\b[^|&]*-X\s*(POST|PUT|PATCH|DELETE)|npm\s+publish)\b/i

/**
 * True when a tool call could have changed durable state. Gates the connection
 * retry: once the session has mutated anything we never blind-replay it (could
 * create a second PR, comment, commit, or edit).
 */
function toolMayMutate(name: string | undefined, input: Record<string, unknown> | undefined): boolean {
  if (!name) return false
  if (MUTATING_FILE_TOOLS.has(name)) return true
  // submit_state is an in-process MCP that just captures a closure variable
  // — no GitHub write, no commit, no external side effect. Replay is safe
  // (last call wins). Treating it as mutating used to wedge approval-gate:
  // its first turn submits state, the LiteLLM proxy then crashes on the
  // heavy CTO request, and the connection-retry path was blocked because
  // submit_state had "mutated" the run.
  if (name === "Bash") return BASH_WRITE_VERB.test(String(input?.command ?? ""))
  return false
}

/**
 * Credentials the agent legitimately needs (Anthropic proxy + the GitHub token
 * git/gh and the repo-fetch MCP use). Everything else unpacked from the
 * consumer's `ALL_SECRETS` blob is stripped before the child env is built.
 */
const AGENT_KEEP_SECRETS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
])

/**
 * Remove repo secrets the agent must never see from its child env. The engine
 * unpacks the consumer's `ALL_SECRETS` JSON into `process.env` (kody-cli.ts),
 * so a naive `...process.env` would hand every secret (npm/Fly tokens, the
 * vault master key, custom PATs) to a Bash-running agent — one `printenv` away
 * from exfiltration. Strip every key that came from `ALL_SECRETS` (except the
 * few the agent needs) plus the raw blob itself. Returns a new object.
 */
export function stripAgentSecrets(env: Record<string, string>): Record<string, string> {
  const out = { ...env }
  const raw = out.ALL_SECRETS
  delete out.ALL_SECRETS
  if (!raw) return out
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const key of Object.keys(parsed)) {
      if (!AGENT_KEEP_SECRETS.has(key)) delete out[key]
    }
  } catch {
    // Unparseable ALL_SECRETS: the blob itself is already deleted above; we
    // can't enumerate individual keys, so leave the rest of env intact rather
    // than guess. (CI always sets a well-formed JSON blob.)
  }
  return out
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const ndjsonDir = opts.ndjsonDir ?? agentRunDir(opts.cwd)
  fs.mkdirSync(ndjsonDir, { recursive: true })
  const ndjsonPath = path.join(ndjsonDir, "last-run.jsonl")

  const env: Record<string, string> = stripAgentSecrets({
    ...(process.env as Record<string, string>),
    SKIP_HOOKS: "1",
    HUSKY: "0",
    CI: process.env.CI ?? "1",
    // MCP servers are spawned asynchronously by the SDK. With the default
    // non-blocking behavior, the SDK announces its tool list at session
    // init while servers are still in `pending`, so their tools never
    // reach the model. Block until each MCP completes its handshake (or
    // the timeout below elapses) so the tool list is complete on first
    // turn.
    MCP_CONNECTION_NONBLOCKING: process.env.MCP_CONNECTION_NONBLOCKING ?? "false",
    MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? "60000",
  })
  if (opts.litellmUrl) {
    env.ANTHROPIC_BASE_URL = opts.litellmUrl
    env.ANTHROPIC_API_KEY = getAnthropicApiKeyOrDummy()
  }

  const startedAt = Date.now()
  const turnTimeoutMs = resolveTurnTimeoutMs(opts)
  // Results live across attempts so the connection retry below can overwrite
  // them; the final loop iteration's values are what we return.
  let outcome: "completed" | "failed" = "failed"
  let outcomeKind: AgentOutcomeKind = "generic_failed"
  let errorMessage: string | undefined
  let tokens: AgentTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
  let messageCount = 0
  let finalText = ""
  let getSubmitted: (() => { cursor: string; data: Record<string, unknown>; done: boolean } | undefined) | undefined

  for (let attempt = 0; ; attempt++) {
    // The SDK message log reflects the final attempt — truncate on each try.
    let ndjsonWriteFailed = false
    let ndjsonWriteError: string | undefined
    const fullLog = fs.createWriteStream(ndjsonPath, { flags: "w" })
    fullLog.on("error", (err) => {
      ndjsonWriteFailed = true
      ndjsonWriteError = err instanceof Error ? err.message : String(err)
    })
    // Collect every `result` message's text. The SDK can emit multiple
    // `result` events when the session restarts mid-flight (background
    // checks, continuation turns). Keeping only the last one silently
    // clobbers earlier terminal output — including a valid DONE marker
    // from the turn that actually finished the work. Joining all of them
    // gives the parser the full terminal stream.
    const resultTexts: string[] = []
    outcome = "failed"
    outcomeKind = "generic_failed"
    errorMessage = undefined
    tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
    messageCount = 0
    // Flips once the session runs a tool that could change durable state —
    // gates the connection retry so we never replay a mutating turn.
    let sawMutatingTool = false
    // Flips once a terminal `result` with subtype "success" arrives. Latches
    // the win: a transient connection error that throws AFTER the success
    // result must not downgrade the outcome to "failed" and replay a session
    // that already finished its work (a real risk for read-only flows where
    // `sawMutatingTool` stays false and the retry gate would otherwise fire).
    let sawTerminalSuccess = false
    let sawLoginRequired = false
    // Flips when the SDK reports a "success" result that produced zero model
    // output — the session never actually reached the model (the classic
    // signature: litellm proxy crashed, SDK still emits subtype "success" with
    // 1 turn / $0). Such a run did no work; trusting it ships an empty commit +
    // PR. We demote it to a retriable failure (below) so the connection-retry
    // path fires ensureBackend() — which restarts a dead proxy and dumps its
    // log tail — and we get a real attempt, or an honest failure that blocks
    // the empty PR.
    let noWorkSuccess = false

    try {
      const queryOptions: Record<string, unknown> = {
        model: opts.model.model,
        cwd: opts.cwd,
        // Fresh array (never mutate the shared DEFAULT_ALLOWED_TOOLS const) so
        // opt-in tools like fetch_repo can be appended below.
        allowedTools: [...(opts.allowedToolsOverride ?? DEFAULT_ALLOWED_TOOLS)],
        permissionMode: opts.permissionModeOverride ?? "acceptEdits",
        env,
      }
      const additionalDirectories = new Set(opts.additionalDirectories ?? [])
      const mcpEntries: Array<[string, Record<string, unknown>]> = []
      if (opts.mcpServers && opts.mcpServers.length > 0) {
        for (const s of opts.mcpServers) {
          const cfg: Record<string, unknown> = { command: s.command }
          if (s.args) cfg.args = s.args
          if (s.env) cfg.env = s.env
          mcpEntries.push([s.name, cfg])
        }
      }
      if (opts.enableVerifyTool && opts.verifyConfig) {
        // Lazy import — keeps the SDK + zod off the cold path when the
        // tool is not enabled (most short-running flows like classify).
        const { buildVerifyMcpServer } = await import("./verifyMcp.js")
        const verifyServer = buildVerifyMcpServer({
          config: opts.verifyConfig as Parameters<typeof buildVerifyMcpServer>[0]["config"],
          cwd: opts.cwd,
          executable: opts.executableName ?? "agent",
          maxAttempts:
            typeof opts.verifyToolMaxAttempts === "number" && opts.verifyToolMaxAttempts > 0
              ? opts.verifyToolMaxAttempts
              : undefined,
        })
        mcpEntries.push(["kody-verify", verifyServer as unknown as Record<string, unknown>])
      }
      if (opts.enableSubmitTool) {
        // Lazy import — keeps the SDK MCP machinery off the cold path for flows
        // that don't submit structured state.
        const { buildSubmitMcpServer } = await import("./submitMcp.js")
        const submitHandle = buildSubmitMcpServer()
        getSubmitted = submitHandle.getSubmitted
        mcpEntries.push(["kody-submit", submitHandle.server as unknown as Record<string, unknown>])
      }
      if (opts.enableCapabilityTool) {
        // Lazy import — only capabilities in locked-toolbox mode pay for this.
        const { buildCapabilityMcpServer } = await import("./capabilityMcp.js")
        if (!opts.capabilityRepoSlug) {
          throw new Error(
            "enableCapabilityTool requires capabilityRepoSlug (owner/name) — set kody.config.json github.{owner,repo} or GITHUB_REPOSITORY env var",
          )
        }
        const capabilityHandle = buildCapabilityMcpServer({
          repoSlug: opts.capabilityRepoSlug,
          state: opts.capabilityState,
          operatorMention: opts.capabilityOperatorMention ?? "",
          ...(opts.capabilitySlug ? { capabilitySlug: opts.capabilitySlug } : {}),
        })
        mcpEntries.push(["kody-capability", capabilityHandle.server as unknown as Record<string, unknown>])
      }
      if (opts.enableDashboardCmsTool) {
        const { buildDashboardCmsMcpServer, DASHBOARD_CMS_MCP_TOOL_NAMES } = await import("./dashboardCmsMcp.js")
        if (!opts.cmsRepoSlug) {
          throw new Error("enableDashboardCmsTool requires cmsRepoSlug (owner/name)")
        }
        const cmsHandle = buildDashboardCmsMcpServer({
          repoSlug: opts.cmsRepoSlug,
          dashboardUrl: opts.cmsDashboardUrl,
          token: opts.cmsToken,
          storeRepoUrl: opts.cmsStoreRepoUrl,
          storeRef: opts.cmsStoreRef,
        })
        mcpEntries.push(["kody-cms", cmsHandle.server as unknown as Record<string, unknown>])
        for (const toolName of DASHBOARD_CMS_MCP_TOOL_NAMES) {
          ;(queryOptions.allowedTools as string[]).push(`mcp__kody-cms__${toolName}`)
        }
      }
      if (opts.enableFetchRepoTool && opts.reposRoot) {
        // Lazy import — keeps the SDK MCP machinery off the cold path for the
        // non-chat flows that never fetch other repos.
        const { buildFetchRepoMcpServer } = await import("./fetchRepoMcp.js")
        const fetchServer = buildFetchRepoMcpServer({
          reposRoot: opts.reposRoot,
          repoToken: opts.repoToken,
        })
        mcpEntries.push(["kody-fetch-repo", fetchServer as unknown as Record<string, unknown>])
        // Auto-approve the tool — otherwise the SDK blocks the MCP call for
        // permission and the agent stalls asking the user (it can't, mid-stream).
        ;(queryOptions.allowedTools as string[]).push("mcp__kody-fetch-repo__fetch_repo")
        // Grant the agent's file tools read/work access to every fetched repo
        // (they live under reposRoot, outside the turn's cwd).
        additionalDirectories.add(opts.reposRoot)
      }
      if (additionalDirectories.size > 0) {
        queryOptions.additionalDirectories = [...additionalDirectories]
      }
      if (mcpEntries.length > 0) {
        queryOptions.mcpServers = Object.fromEntries(mcpEntries)
      }
      if (opts.pluginPaths && opts.pluginPaths.length > 0) {
        queryOptions.plugins = opts.pluginPaths.map((p) => ({ type: "local", path: p }))
      }
      if (opts.agents && Object.keys(opts.agents).length > 0) {
        queryOptions.agents = opts.agents
      }
      if (typeof opts.maxTurns === "number" && opts.maxTurns > 0) {
        queryOptions.maxTurns = opts.maxTurns
      }
      // `reasoningEffort` is the canonical user-facing surface. When
      // set, it fully owns the maxThinkingTokens slot — including
      // `"off"`, which clears the block entirely (cheapest path). The
      // explicit `maxThinkingTokens` field is the legacy surface for
      // direct callers (tests, executables) that don't go through
      // the level vocabulary; it only applies when `reasoningEffort`
      // is not provided.
      if (opts.reasoningEffort !== undefined && opts.reasoningEffort !== null) {
        if (opts.reasoningEffort === "off") {
          // Explicitly off: do NOT set maxThinkingTokens. Also clear
          // any value a legacy caller might have left in the option
          // bag. The SDK sees no thinking block.
        } else {
          const budget = REASONING_BUDGETS[opts.reasoningEffort]
          if (budget) queryOptions.maxThinkingTokens = budget
        }
      } else if (typeof opts.maxThinkingTokens === "number" && opts.maxThinkingTokens > 0) {
        queryOptions.maxThinkingTokens = opts.maxThinkingTokens
      }
      if (typeof opts.systemPromptAppend === "string" && opts.systemPromptAppend.length > 0) {
        const systemPrompt: Record<string, unknown> = {
          type: "preset",
          preset: "claude_code",
          append: opts.systemPromptAppend,
        }
        if (opts.cacheable) systemPrompt.excludeDynamicSections = true
        queryOptions.systemPrompt = systemPrompt
      } else if (opts.cacheable) {
        // Cacheable opt-in without an append still wants the preset's
        // dynamic sections stripped so the prefix is cacheable.
        queryOptions.systemPrompt = {
          type: "preset",
          preset: "claude_code",
          excludeDynamicSections: true,
        }
      }
      queryOptions.settingSources = opts.settingSources ?? ["project", "local"]
      // Pin the SDK's native binary to a job-stable path so npm pruning the
      // `_npx` cache mid-job (during a long run phase) can't make a later
      // phase fail with "native binary not found". Null => SDK default.
      const stableBinary = ensureStableClaudeBinary()
      if (stableBinary) {
        queryOptions.pathToClaudeCodeExecutable = stableBinary
      }
      const result = query({
        prompt: opts.prompt,
        // biome-ignore lint/suspicious/noExplicitAny: SDK options type is narrow; mcpServers is runtime-passthrough.
        options: queryOptions as any,
      })

      // Manual iterator loop so we can race each `next()` against a watchdog
      // timer. A `for await` hides the underlying promise and offers no way
      // to bail out when the SDK stalls mid-turn (hung tool call, network
      // deadlock). Racing makes a hang surface as a structured failure
      // (outcome=failed, error=stalled) within `turnTimeoutMs` instead of
      // wedging the executor until the outer shell timeout fires.
      const iterator =
        typeof (result as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> })[Symbol.asyncIterator] ===
        "function"
          ? (result as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator]()
          : (result as unknown as AsyncIterator<unknown>)

      while (true) {
        const nextPromise = iterator.next()
        let timedOut = false
        let timer: NodeJS.Timeout | undefined
        let next: IteratorResult<unknown>
        if (turnTimeoutMs > 0) {
          const timeoutPromise = new Promise<IteratorResult<unknown>>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true
              resolve({ done: true, value: undefined })
            }, turnTimeoutMs)
          })
          next = await Promise.race([nextPromise, timeoutPromise])
          if (timer) clearTimeout(timer)
        } else {
          next = await nextPromise
        }
        if (timedOut) {
          outcome = "failed"
          outcomeKind = "stalled"
          errorMessage = `agent stalled: no SDK message in ${Math.round(turnTimeoutMs / 1000)}s`
          // Best-effort iterator cleanup so the SDK can release tool processes.
          if (typeof iterator.return === "function") {
            try {
              await iterator.return(undefined)
            } catch {
              /* ignore — we already know we're aborting */
            }
          }
          break
        }
        if (next.done) break
        const msg = next.value
        messageCount++
        if (!ndjsonWriteFailed) {
          try {
            fullLog.write(`${JSON.stringify(msg)}\n`)
          } catch (e) {
            ndjsonWriteFailed = true
            ndjsonWriteError = e instanceof Error ? e.message : String(e)
          }
        }

        const line = renderEvent(msg as SdkMessageLike, { verbose: opts.verbose, quiet: opts.quiet })
        if (line) {
          if (isClaudeLoginRequiredText(line)) sawLoginRequired = true
          process.stdout.write(`${line}\n`)
        }

        const m = msg as SdkMessageLike

        // Stream progress events (thinking / tool calls / text deltas) to
        // the consumer. Chat mode hooks this to push live updates to the
        // dashboard SSE; non-chat callers can leave onProgress unset and
        // pay zero cost. Errors are swallowed — instrumentation must not
        // break the actual turn.
        if (opts.onProgress) {
          const blocks = m.message?.content ?? []
          for (const block of blocks) {
            try {
              if (block.type === "thinking") {
                const t = (block as { thinking?: unknown }).thinking
                if (typeof t === "string" && t.length > 0) {
                  await opts.onProgress({ kind: "thinking", thinking: t })
                }
              } else if (block.type === "tool_use") {
                const b = block as { name?: string; input?: Record<string, unknown>; id?: string }
                await opts.onProgress({
                  kind: "tool_use",
                  name: b.name ?? "tool",
                  input: b.input,
                  id: b.id,
                })
              } else if (block.type === "tool_result") {
                const b = block as { tool_use_id?: string; content?: unknown; is_error?: boolean }
                const content =
                  typeof b.content === "string"
                    ? b.content
                    : (() => {
                        try {
                          return JSON.stringify(b.content)
                        } catch {
                          return ""
                        }
                      })()
                await opts.onProgress({
                  kind: "tool_result",
                  toolUseId: b.tool_use_id,
                  content,
                  isError: b.is_error,
                })
              } else if (block.type === "text") {
                const b = block as { text?: string }
                if (typeof b.text === "string" && b.text.length > 0) {
                  await opts.onProgress({ kind: "text", text: b.text })
                }
              }
            } catch {
              /* progress callback must not break the run */
            }
          }
        }
        // Accumulate token usage. The SDK attaches `usage` to result messages
        // (and sometimes to assistant messages); we sum whatever surfaces so
        // that the per-stage event log captures the real cost regardless of
        // where the SDK chose to put it.
        const usage = (m as { usage?: Record<string, unknown> }).usage
        if (usage && typeof usage === "object") {
          const i = Number(usage.input_tokens ?? 0)
          const o = Number(usage.output_tokens ?? 0)
          const cr = Number(usage.cache_read_input_tokens ?? 0)
          const cc = Number(usage.cache_creation_input_tokens ?? 0)
          if (Number.isFinite(i)) tokens.input += i
          if (Number.isFinite(o)) tokens.output += o
          if (Number.isFinite(cr)) tokens.cacheRead += cr
          if (Number.isFinite(cc)) tokens.cacheCreate += cc
        }
        if (!sawMutatingTool) {
          const blocks = m.message?.content ?? []
          for (const block of blocks) {
            if (block.type === "tool_use") {
              const b = block as { name?: string; input?: Record<string, unknown> }
              if (toolMayMutate(b.name, b.input)) {
                sawMutatingTool = true
                break
              }
            }
          }
        }
        if (m.type === "result") {
          if (m.subtype === "success") {
            outcome = "completed"
            outcomeKind = "ok"
            sawTerminalSuccess = true
            const text = (typeof m.result === "string" ? m.result : "").trim()
            if (isClaudeLoginRequiredText(text)) sawLoginRequired = true
            if (text) resultTexts.push(text)
          } else {
            outcome = "failed"
            outcomeKind = classifySubtype(m.subtype)
            errorMessage = `result subtype: ${m.subtype ?? "unknown"}`
          }
        }
      }
    } catch (e) {
      // Don't clobber an already-finished turn: if the success result arrived
      // before this throw, the work is done — a late connection drop on the
      // tail of the stream must not flip us back to "failed" and trigger a
      // replay. Record the error for logs but keep the completed outcome.
      if (sawTerminalSuccess) {
        errorMessage = e instanceof Error ? e.message : String(e)
      } else {
        outcome = "failed"
        outcomeKind = "model_error"
        errorMessage = e instanceof Error ? e.message : String(e)
      }
    } finally {
      try {
        fullLog.end()
      } catch {
        /* best effort */
      }
    }

    if (ndjsonWriteFailed) {
      // Phase 0 made the executor record agent durations + tokens via events.
      // If the NDJSON message log went silent mid-run the post-mortem is
      // incomplete — surface that to stderr so the operator knows a "successful"
      // log file may be truncated. Previously this was swallowed.
      process.stderr.write(
        `[kody agent] NDJSON write failed (post-mortem may be incomplete): ${ndjsonWriteError ?? "unknown error"}\n`,
      )
    }
    finalText = resultTexts.join("\n\n---\n\n")
    if (outcome === "completed" && sawLoginRequired) {
      outcome = "failed"
      outcomeKind = "model_error"
      errorMessage = "Claude Code reported it is not logged in; refusing to mark agent run successful"
    }

    // Detect a hollow "success" — one the SDK reported as subtype "success"
    // but where the model never actually answered (the dead-proxy signature:
    // 1 turn, $0, then ConnectionRefused). Two signals, only checked on a
    // non-mutating "success" so a real run is never touched:
    //
    //   1. Backend dead (DEFINITIVE): the litellm proxy is unreachable right
    //      after the turn. A live model can't have answered through a dead
    //      proxy, so the "success" is hollow regardless of what text/tokens the
    //      SDK attached (the crashed session can carry the SDK's own error
    //      string as finalText, which is why the text heuristic alone misses
    //      it — see A-Guy #2211).
    //   2. Zero output (HEURISTIC): no result text AND no output tokens — used
    //      when there is no proxy to probe (direct-Anthropic) or the proxy was
    //      already restarted out from under us.
    //
    // Demoting routes the run through the retry path below, which restarts the
    // proxy via ensureBackend() (dumping its log tail — the only place the
    // crash reason surfaces) and retries; on exhaustion it ends `failed`, so
    // commit + ensurePr skip it instead of shipping an empty PR.
    if (outcome === "completed" && !sawMutatingTool) {
      const backendDead = opts.isBackendHealthy ? !(await opts.isBackendHealthy()) : false
      const zeroOutput = tokens.output === 0 && finalText === ""
      if (backendDead || zeroOutput) {
        outcome = "failed"
        outcomeKind = "model_error"
        noWorkSuccess = true
        errorMessage =
          errorMessage ??
          (backendDead
            ? "model backend unreachable after a reported success — proxy crashed mid-request (hollow success)"
            : "session reported success but produced no model output (0 output tokens) — backend likely unreachable")
      }
    }

    // Retry only a transient connection failure (or the no-work success above,
    // which is the same dead-backend symptom under a "success" label), and only
    // while the session hasn't mutated anything — replaying a mutating turn
    // could double-apply a write (second PR, comment, commit, edit).
    const shouldRetry =
      outcome === "failed" &&
      attempt < MAX_CONNECTION_RETRIES &&
      !sawMutatingTool &&
      (isTransientConnectionError(errorMessage) || noWorkSuccess)
    if (!shouldRetry) break

    const delayMs = CONNECTION_RETRY_BASE_MS * 2 ** attempt
    process.stderr.write(
      `[kody agent] transient connection error (attempt ${attempt + 1}/${MAX_CONNECTION_RETRIES + 1}); retrying in ${Math.round(delayMs / 1000)}s: ${errorMessage}\n`,
    )
    // Let the owner restart a crashed model proxy before we retry — a bare
    // retry against the dead backend would just fail the same way.
    if (opts.ensureBackend) {
      try {
        await opts.ensureBackend()
      } catch (e) {
        process.stderr.write(`[kody agent] backend recovery failed: ${e instanceof Error ? e.message : String(e)}\n`)
      }
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }

  const submittedState = getSubmitted?.()
  return {
    outcome,
    outcomeKind,
    finalText,
    ...(submittedState ? { submittedState } : {}),
    error: errorMessage,
    ndjsonPath,
    durationMs: Date.now() - startedAt,
    tokens,
    messageCount,
  }
}
