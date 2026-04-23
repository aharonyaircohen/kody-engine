/**
 * Types shared by the generic executor and executables.
 *
 * The executor reads a Profile, validates the user's CLI args against
 * Profile.inputs, then runs the declared preflight scripts → agent →
 * postflight scripts. The executor knows nothing about any specific role
 * (build, review, plan, etc.) — it only executes what the profile declares.
 */

import type { AgentResult } from "../agent.js"
import type { KodyConfig } from "../config.js"
import type { Phase } from "../state.js"

// ────────────────────────────────────────────────────────────────────────────
// Profile shape (mirrors the JSON on disk).
// ────────────────────────────────────────────────────────────────────────────

export interface Profile {
  name: string
  describe: string
  /**
   * Semantic role — what this executable IS, not when it runs.
   *   - primitive:    single-step agent executor (flow → agent → verify → commit → PR).
   *   - orchestrator: no-agent, drives primitives via a postflight transition table.
   *   - watch:        scheduled observer that inspects repo state and may trigger other executables.
   *   - utility:      no-agent, one-off administrative work (scaffolding, release, etc.).
   *
   * Roles enforce shape at profile-load time and let help/dispatch treat
   * executables differently by category.
   */
  role: "primitive" | "orchestrator" | "watch" | "utility"
  /**
   * Execution model — orthogonal to `role`.
   * `oneshot` (default): single invocation on demand.
   * `scheduled`: fires periodically via an external cron (typically GHA
   * `schedule:`). Scheduled profiles must declare a `schedule` cron string.
   */
  kind: "oneshot" | "scheduled"
  /** Cron expression for scheduled profiles (e.g. "0 8 * * MON"). */
  schedule?: string
  /**
   * Task-state phase label emitted when this executable completes successfully.
   * Failing actions always set phase to "failed" regardless. Omitted → "idle".
   * Lets state.ts stay generic — phase semantics live on the profile.
   */
  phase?: Phase
  inputs: InputSpec[]
  claudeCode: ClaudeCodeSpec
  cliTools: CliToolSpec[]
  scripts: {
    preflight: ScriptEntry[]
    postflight: ScriptEntry[]
  }
  outputContract?: OutputContract
  /**
   * Declared artifacts consumed by this executable. The resolveArtifacts
   * preflight loads each into ctx.data.artifacts[name] from the task-state
   * comment. If `required: true` and the artifact is absent, the executable
   * fails fast.
   */
  inputArtifacts: InputArtifactSpec[]
  /**
   * Declared artifacts produced by this executable. The persistArtifacts
   * postflight reads the named source field from ctx.data and writes an
   * Artifact entry into the task-state comment's `artifacts` map.
   */
  outputArtifacts: OutputArtifactSpec[]
  /** Absolute directory the profile was loaded from. Used to resolve prompt.md. */
  dir: string
}

export interface InputArtifactSpec {
  /** Artifact name (the key in state.artifacts). */
  name: string
  /** If true, the executable fails when this artifact is missing from state. */
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
  /** Text appended on top of Claude Code's baseline system prompt. */
  systemPromptAppend: string | null
  /** SDK built-in tools this executable is allowed to use (capability pack). */
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
  script: string
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
}

export interface OutputContract {
  finalMessage?: {
    onSuccess?: string[]
    onFailure?: string[]
  }
}

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
