/**
 * Types shared by the generic executor and agentActions.
 *
 * The executor reads a Profile, validates the user's CLI args against
 * Profile.inputs, then runs the declared preflight scripts → agent →
 * postflight scripts. The executor knows nothing about any specific role
 * (build, review, plan, etc.) — it only executes what the profile declares.
 */

import type { AgentResult } from "../agent.js"
import type { KodyConfig, ReasoningEffort } from "../config.js"
import type { Phase } from "../state.js"

// ────────────────────────────────────────────────────────────────────────────
// Profile shape (mirrors the JSON on disk).
// ────────────────────────────────────────────────────────────────────────────

export type CapabilityKind = "observe" | "act" | "verify"

export interface Profile {
  name: string
  /**
   * Public action name owned by a agentResponsibility. A user may type `@kody <action>`;
   * dispatch resolves that action to the agentResponsibility, then the agentResponsibility selects the
   * implementation agentAction. Absent → the agentResponsibility slug/name is the action.
   */
  action?: string
  /**
   * Optional agent this agentAction runs *as*. When set, the executor
   * loads `.kody/agents/<agent>.md` and injects that agent (authoritative
   * identity) ahead of the agentAction's own system-prompt append. This is the
   * unification hook: a "agentResponsibility" is just an agentAction + an agent. Absent →
   * runs with no agent (unchanged legacy behaviour). A declared-but-missing
   * agent file is fatal at run time (see src/agents.ts).
   */
  agent?: string
  describe: string
  /**
   * Author-facing capability promise for a agentResponsibility/agentAction. This classifies the
   * shape of result it should return; it does not change executor control flow.
   */
  capabilityKind?: CapabilityKind
  /**
   * Semantic role — what this agentAction IS, not when it runs.
   *   - primitive:    single-step agent executor (flow → agent → verify → commit → PR).
   *   - orchestrator: no-agent, drives primitives via a postflight transition table
   *                   (comment-based, one GHA run per step).
   *   - container:    no-agent, runs declared `children` sequentially in-process
   *                   (one GHA run for the whole flow). Routing is done by per-child
   *                   `next` maps over action types — no @kody comments dispatched.
   *   - watch:        scheduled observer that inspects repo state and may trigger other agentActions.
   *   - utility:      no-agent, one-off administrative work (scaffolding, release, etc.).
   *
   * Roles enforce shape at profile-load time and let help/dispatch treat
   * agentActions differently by category.
   */
  role: "primitive" | "orchestrator" | "container" | "watch" | "utility"
  /**
   * A agentResponsibility is the WHY/WHEN layer: it references an agentAction (the HOW) by name
   * rather than embedding it. When set, the loader resolves that agentAction's
   * full profile (claudeCode/scripts/prompt/agents) and overlays this agentResponsibility's
   * name + agent (WHO) + every (WHEN) + mentions. Absent → this profile IS an
   * agentAction (defines its own how). agentAction = how, agent = who, agentResponsibility = why.
   */
  agentAction?: string
  /**
   * Execution model — orthogonal to `role`.
   * `oneshot` (default): single invocation on demand.
   * `scheduled`: fires periodically via an external cron (typically GHA
   * `schedule:`). Scheduled profiles must declare a `schedule` cron string.
   */
  kind: "oneshot" | "scheduled"
  /**
   * Recurrence cadence for a agentResponsibility that runs on a timer (unified successor to a
   * markdown agentResponsibility's `every:` metadata). One of the ScheduleEvery values
   * ("15m".."7d" | "manual"). Present → the agent-responsibility-scheduler fires a one-shot run
   * when due (no target). Absent → on-demand only (runs against an issue/PR).
   * This is what makes "scheduled" just a field on the one agentResponsibility shape.
   */
  every?: string
  /**
   * Locked-toolbox palette (unified successor to a markdown agentResponsibility's `tools:`
   * metadata). When non-empty, loadAgentResponsibilityState sets ctx.data.agentResponsibilityTools so the
   * executor spins up the in-process kody-agentResponsibility MCP server and the agent runs
   * MCP-only (Bash/Read revoked unless also in claudeCode.tools). Absent →
   * normal SDK tools.
   */
  agentResponsibilityTools?: string[]
  /**
   * GitHub logins (no leading `@`) this agentResponsibility's output should mention. Rendered
   * to `@a @b` and exposed to the prompt as {{mentions}} (and as the agentResponsibility-MCP
   * operator mention), mirroring a markdown agentResponsibility's `mentions:` metadata.
   */
  mentions?: string[]
  /** Cron expression for scheduled profiles (e.g. "0 8 * * MON"). */
  schedule?: string
  /**
   * Task-state phase label emitted when this agentAction completes successfully.
   * Failing actions always set phase to "failed" regardless. Omitted → "idle".
   * Lets state.ts stay generic — phase semantics live on the profile.
   */
  phase?: Phase
  inputs: InputSpec[]
  claudeCode: ClaudeCodeSpec
  cliTools: CliToolSpec[]
  /**
   * Optional lifecycle macro. When set, the profile loader applies a
   * predefined preflight/postflight wrapper around `scripts.preflight` and
   * `scripts.postflight` before returning the profile. Registry of lifecycles
   * lives in src/lifecycles/. Unknown values are rejected at load time.
   *
   * Lifecycles exist to consolidate orchestration boilerplate (label,
   * context loading, verify, commit, comment) that recurs across many
   * agentActions. Per-agentAction specifics still go in `scripts.preflight`
   * and `scripts.postflight` — the lifecycle wraps them, it doesn't
   * replace them.
   */
  lifecycle?: string
  /**
   * Lifecycle-specific configuration. Shape depends on `lifecycle`. Validated
   * by each lifecycle expander, not by the generic profile parser.
   */
  lifecycleConfig?: Record<string, unknown>
  scripts: {
    preflight: ScriptEntry[]
    postflight: ScriptEntry[]
  }
  outputContract?: OutputContract
  /**
   * Declared artifacts consumed by this agentAction. The resolveArtifacts
   * preflight loads each into ctx.data.artifacts[name] from the task-state
   * comment. If `required: true` and the artifact is absent, the agentAction
   * fails fast.
   */
  inputArtifacts: InputArtifactSpec[]
  /**
   * Declared artifacts produced by this agentAction. The persistArtifacts
   * postflight reads the named source field from ctx.data and writes an
   * Artifact entry into the task state's `artifacts` map.
   */
  outputArtifacts: OutputArtifactSpec[]
  /**
   * Container children — required when role === "container", forbidden otherwise.
   * Defines the in-process step sequence and routing map. See ContainerChild.
   */
  children?: ContainerChild[]
  /**
   * Whether the container should `git reset --hard HEAD` between
   * children to discard tracked-file modifications a prior child left
   * behind. Default `true` (preserves the legacy bug-safe behaviour
   * — see executor.ts:runContainerLoop notes). Set `false` for
   * containers whose children are expected to share intermediate
   * state (e.g. bug's `reproduce` writing a failing test that `run`
   * then makes pass). Only honoured when `role === "container"`.
   */
  resetBetweenChildren?: boolean
  /**
   * Phase 5 in-process handoff: when true, the container's loop runs
   * the shared context loaders (loadConventions, loadPriorArt,
   * loadMemoryContext, loadCoverageRules) ONCE after its own preflight
   * completes, then passes the resulting `ctx.data` snapshot to every
   * child via `ExecutorInput.preloadedData`. Each child's loaders take
   * their fast path (added in 0.4.63) and skip the redundant
   * GitHub/filesystem round-trips.
   *
   * Default `false` (opt-in) so the change is gated to containers
   * that have been verified end-to-end. Only honoured when
   * `role === "container"`.
   */
  preloadContext?: boolean
  /** Absolute directory the profile was loaded from. Used to resolve prompt.md. */
  dir: string
  /**
   * Prompt template files captured (by absolute path) at load time, BEFORE any
   * preflight runs. composePrompt prefers these over a fresh disk read so the
   * template survives working-tree churn from runFlow's branch setup — on the CI
   * runner a branch checkout can drop the tracked-but-ignore-negated
   * `.kody/agent-actions/<name>/` dir, and reading prompt.md afterwards fails with
   * ENOENT even though profile.json (read here, earlier) loaded fine.
   */
  promptTemplates?: Record<string, string>
  /**
   * Subagent markdown captured (by declared name) at load time, BEFORE any
   * task branch switch — same rationale as promptTemplates. loadSubagents
   * prefers this snapshot so a agentResponsibility's `agents/` surviving only on the default
   * checkout (e.g. `.kody/agent-responsibilities/<slug>/agents/` absent on a PR branch) doesn't
   * crash a PR-targeted agentResponsibility. Populated by captureSubagentTemplates.
   */
  subagentTemplates?: Record<string, string>
}

/**
 * One step in a container's child sequence.
 *
 * The container executor runs the first child, reads the resulting action
 * type from `state.core.lastOutcome`, then looks it up in `next`:
 *   - exact match → either the name of another child in this container, or
 *     the literal "done" / "abort"
 *   - "*" wildcard → fallback when no exact match
 *   - no match → container aborts
 */
export interface ContainerChild {
  /** Name of the agentAction to invoke (must resolve via the registry). */
  exec: string
  /**
   * Where to source the target identifier from when invoking this child.
   *   - "issue": pass --issue <ctx.args.issue>
   *   - "pr":    parse PR number from state.core.prUrl, pass --pr <N>.
   *              If state.core.prUrl is not set, the container aborts with
   *              an AGENT_NOT_RUN action.
   */
  target: "issue" | "pr"
  /**
   * Map from action.type → next step. Each value must be the name of another
   * child in this container, "done" (exit 0), or "abort" (exit 1). Lookup is
   * exact-match first, then "*" as a wildcard fallback.
   */
  next: Record<string, string>
}

export interface InputArtifactSpec {
  /** Artifact name (the key in state.artifacts). */
  name: string
  /** If true, the agentAction fails when this artifact is missing from state. */
  required?: boolean
}

export interface OutputArtifactSpec {
  /** Artifact name (the key in state.artifacts). */
  name: string
  /** Informational format tag ("markdown", "text", …). */
  format: string
  /** Dotted path into ctx.data to read the payload from (e.g. "prSummary"). */
  from: string
}

export interface InputSpec {
  name: string
  flag: string
  type: "int" | "string" | "bool" | "enum"
  /** Allowed values for `type: "enum"`. */
  values?: string[]
  required?: boolean
  /**
   * Only required when another input matches one of these values.
   * e.g. `{ mode: "run" }` or `{ mode: ["fix", "fix-ci", "resolve"] }`.
   */
  requiredWhen?: Record<string, string | string[]>
  /**
   * When true, this input collects any free-text left over from comment
   * dispatch after flag/enum/bool parsing. Only one input per profile may
   * set this. Used by e.g. `fix.feedback` so `@kody please change X` lands
   * "please change X" in `feedback` without hardcoding that in the router.
   */
  bindsCommentRest?: boolean
  describe: string
}

export interface ClaudeCodeSpec {
  /** "inherit" → use KodyConfig.agent.model. Or a concrete "provider/model". */
  model: string
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions"
  /** null = unbounded. */
  maxTurns: number | null
  /** Extended-thinking token budget. null = SDK default. */
  maxThinkingTokens: number | null
  /** User-facing effort level. When set, preferred over maxThinkingTokens. */
  reasoningEffort?: ReasoningEffort | null
  /**
   * Watchdog: abort the agent if no SDK message arrives within this many
   * seconds. Per-profile override for the global 600s default. Useful on
   * `run`/`fix` stages where a long test suite can leave the SDK silent
   * longer than the default. Set to 0 or a negative number to disable
   * the watchdog entirely. null/undefined → use the global default.
   */
  maxTurnTimeoutSec?: number | null
  /** Text appended on top of Claude Code's baseline system prompt. */
  systemPromptAppend: string | null
  /**
   * Cross-process prompt caching opt-in. When true, the agent invocation
   * sets `systemPrompt.excludeDynamicSections: true` so per-user dynamic
   * content (cwd, git status, auto-memory) is stripped from the preset
   * and re-injected as the first user message. The remaining preset
   * becomes byte-identical across runs and benefits from Anthropic's
   * 5-min server-side prompt cache. Recommended for hot-path stages
   * (`run`, `fix`, `classify`) where the same workflow fires many
   * times in a short window.
   *
   * Default: false (preserves legacy behaviour). No-op if the SDK does
   * not support `excludeDynamicSections` (forward-compatible).
   */
  cacheable?: boolean
  /**
   * Phase 3 opt-in: expose an in-process `verify` MCP tool to the agent
   * so it can iterate on typecheck/lint/test failures inside one SDK
   * session instead of needing a `fix-ci` round trip. The tool is
   * bounded by `verifyAttempts` (default 4). The postflight `verify`
   * script still runs after the agent finishes as the final ratifier.
   * Default false.
   */
  enableVerifyTool?: boolean
  /**
   * Opt-in: expose an in-process `submit_state` tool the agent calls to
   * persist its next state, instead of relying on a trailing fenced
   * `kody-job-next-state` block it must remember to emit. Used by agent-responsibility-tick.
   * The fenced block stays supported as a fallback. Default false.
   */
  enableSubmitTool?: boolean
  /**
   * Hard cap on verify-tool invocations per agent session when
   * `enableVerifyTool` is true. Default 4 (≈3 fix iterations after the
   * first attempt). Set to 0 or omit to use the default.
   */
  verifyAttempts?: number | null
  /** SDK built-in tools this agentAction is allowed to use (capability pack). */
  tools: string[]
  /**
   * Names of bundled hook configs to load (from src/plugins/hooks/<name>.json).
   * Each referenced file is a Claude Code hooks JSON ({ hooks: { PreToolUse: [...] } }).
   * Merged into a synthetic plugin at runtime.
   */
  hooks: string[]
  /** Names of bundled skills to load (from src/plugins/skills/<name>/SKILL.md). */
  skills: string[]
  /** Names of bundled slash commands to load (from src/plugins/commands/<name>.md). */
  commands: string[]
  /** Names of bundled subagents to load (from src/plugins/agents/<name>.md). */
  subagents: string[]
  /**
   * External plugin directory paths (absolute, or relative to the profile dir).
   * Loaded as-is by the SDK via { type: 'local', path }.
   */
  plugins: string[]
  mcpServers: McpServerSpec[]
}

export interface McpServerSpec {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface CliToolSpec {
  name: string
  install: {
    required: boolean
    checkCommand: string
    installCommand?: string
  }
  verify: string
  usage: string
  allowedUses: string[]
}

export interface ScriptEntry {
  /**
   * Name of a registered TS function in src/scripts/index.ts. Mutually
   * exclusive with `shell` — exactly one must be set.
   */
  script?: string
  /**
   * Filename of a shell script colocated with the agentAction
   * (e.g. "apply-prefer.sh"). Resolved relative to the profile's
   * directory. Invoked via `bash <path> <with-args>` with ctx.args
   * exposed as env vars (KODY_ARG_<UPPER_NAME>=<value>). A stdout
   * line `KODY_SKIP_AGENT=true` signals the executor to bypass the
   * agent. Non-zero exit is treated as a preflight failure.
   */
  shell?: string
  /**
   * Optional conditional. Keys are dotted paths into the context (e.g.
   * "args.mode"). Values are a single primitive or an array of primitives.
   * The script runs only when every key matches. Missing `runWhen` = always.
   */
  runWhen?: Record<string, string | number | boolean | Array<string | number | boolean>>
  /**
   * Optional per-call arguments passed to the script as the last positional
   * parameter. Used by the orchestrator's transition table so the same
   * dispatcher script can be reused with different `next` targets.
   */
  with?: Record<string, string | number | boolean>
  /**
   * Optional shell-script timeout in seconds. Only honored on `shell` entries.
   * Falls back to `KODY_SHELL_TIMEOUT_SEC` env var, then the 300s default.
   * Long-running shells (release publish, large repo verify) should declare
   * a higher value rather than relying on the default and getting SIGKILLed
   * with an opaque "exited -1".
   */
  timeoutSec?: number
}

export interface OutputContract {
  finalMessage?: {
    onSuccess?: string[]
    onFailure?: string[]
  }
}

export interface CapabilityAlert {
  level?: "info" | "warning" | "error"
  message: string
}

export interface CapabilitySuggestedAction {
  action: string
  args?: Record<string, unknown>
  reason?: string
}

export interface CapabilityResourceRef {
  type: string
  id?: string | number
  number?: number
  url?: string
  name?: string
}

export interface CapabilityEvidenceItem {
  source?: string
  message: string
  url?: string
}

export interface ObserveResult {
  kind: "observe"
  facts?: Record<string, unknown>
  alerts?: CapabilityAlert[]
  suggestedActions?: CapabilitySuggestedAction[]
  evidence?: Record<string, unknown>
}

export interface ActResult {
  kind: "act"
  status: "created" | "changed" | "triggered" | "skipped" | "failed"
  changedResources?: CapabilityResourceRef[]
  createdResources?: CapabilityResourceRef[]
  actionResult?: Record<string, unknown>
  evidence?: Record<string, unknown>
}

export interface VerifyResult {
  kind: "verify"
  passed: boolean
  evidence?: CapabilityEvidenceItem[]
  blockers?: string[]
  facts?: Record<string, unknown>
}

export type CapabilityResult = ObserveResult | ActResult | VerifyResult

// ────────────────────────────────────────────────────────────────────────────
// Run-time context passed to every script.
// ────────────────────────────────────────────────────────────────────────────

export interface Context {
  /** Validated CLI args, keyed by input `name`. */
  args: Record<string, unknown>
  /** Project root. */
  cwd: string
  /** Loaded kody.config.json. */
  config: KodyConfig
  /** Stream-output verbosity. */
  verbose?: boolean
  quiet?: boolean
  /** Opaque bag scripts populate during preflight (issue, pr, diff, logs, …). */
  data: Record<string, unknown>
  /** Final output the executor returns. */
  output: {
    exitCode: number
    prUrl?: string
    reason?: string
    /**
     * In-process hand-off to the next stage. A stage (e.g. `classify`) sets
     * this so the orchestrator runs the chosen sub-orchestrator
     * (feature/bug/spec/chore) in the same process — instead of posting an
     * `@kody <next>` comment, which is silently ignored when Kody comments as
     * a GitHub App (bot author), stalling the pipeline at classify.
     */
    nextDispatch?: {
      action?: string
      agentResponsibility?: string
      agentAction?: string
      cliArgs: Record<string, unknown>
    }
    /** In-process hand-off to a full Job, preserving job identity in task state. */
    nextJob?: Job
    /** Where to return after nextJob succeeds. Used by task-jobs to keep draining pending work. */
    afterNextJob?: {
      action?: string
      agentResponsibility?: string
      agentAction?: string
      cliArgs: Record<string, unknown>
    }
  }
  /**
   * If a preflight script sets this to true, the executor skips the agent
   * invocation and proceeds straight to postflight. Used by e.g. the
   * clean-merge resolve path.
   */
  skipAgent?: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Script signatures. Two phases, two contracts.
// ────────────────────────────────────────────────────────────────────────────

export type ScriptArgs = Record<string, string | number | boolean>

export type PreflightScript = (ctx: Context, profile: Profile, args?: ScriptArgs) => Promise<void>

export type PostflightScript = (
  ctx: Context,
  profile: Profile,
  agentResult: AgentResult | null,
  args?: ScriptArgs,
) => Promise<void>

/** A registered script may be either phase; registry looks it up by name. */
export type AnyScript = PreflightScript | PostflightScript

// ────────────────────────────────────────────────────────────────────────────
// Job — the unified work request (task-state jobs collect run attempts).
//
// A Job is the required work the engine tries to execute, regardless of how it
// was triggered. It must reference a agentResponsibility/action (why). The agentAction is only
// the agentResponsibility-selected implementation detail (how), never a standalone request.
// Task state stores this durable job separately from individual run attempts.
// Two flavors:
//   - "instant"   — run once now (an `@kody <verb>` comment or a manual dispatch)
//   - "scheduled" — fired on `schedule` (cron) by the tick path
//
// `runJob` (src/job.ts) lowers a Job onto the private executor after resolving
// the agentResponsibility, and seeds both stable job metadata and per-run metadata.
// ────────────────────────────────────────────────────────────────────────────

export type JobFlavor = "instant" | "scheduled"

export interface Job {
  /** Public action the user/operator invoked. Mirrors the agentResponsibility action. */
  action?: string
  /** How: implementation profile selected by the agentResponsibility. Not valid by itself. */
  agentAction?: string
  /** Why (referenced): a agentResponsibility slug whose intent drives the run. */
  agentResponsibility?: string
  /** Why (inline): free-text intent, e.g. an `@kody` comment body. Untrusted —
   *  fenced where it enters a prompt, not here. */
  why?: string
  /** Who: an agent identity slug. */
  agent?: string
  /** When: cron expression. Set for scheduled jobs, absent for instant. */
  schedule?: string
  /** The issue/PR number this job acts on, when applicable. */
  target?: number
  /** Args passed through to the agentAction (mirrors DispatchResult.cliArgs). */
  cliArgs: Record<string, unknown>
  /** Run once now ("instant") or on the schedule ("scheduled"). */
  flavor: JobFlavor
  /** Manual force-run (bypass cadence) for a scheduled job. */
  force?: boolean
}
