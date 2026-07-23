import * as fs from "node:fs"
import * as path from "node:path"

export interface TestRequirement {
  pattern: string
  requireSibling: string
}

export type GoalActivation = string | ScheduledGoalActivation

export interface ScheduledGoalActivation {
  template: string
  every?: string
  idPrefix?: string
  preferredRunTime?: { time: string; timezone: string }
  facts?: Record<string, unknown>
}

export interface KodyConfig {
  quality: {
    typecheck: string
    lint: string
    format: string
    testUnit: string
  }
  git: {
    defaultBranch: string
  }
  github: {
    owner: string
    repo: string
  }
  agent: {
    model: string
    /**
     * Thinking effort. Maps to the Claude Agent SDK's `maxThinkingTokens`
     * (Anthropic extended thinking). When unset, the SDK runs without
     * thinking — cheaper, faster, no reasoning preamble. A chat session
     * can override per-session via the `REASONING_EFFORT` env var or
     * `--reasoning-effort` CLI flag.
     *
     *   "agent": { "model": "claude/...", "reasoningEffort": "medium" }
     *
     * Budgets: off → not set (no thinking, no extra cost);
     *          low → 2_048 · medium → 10_000 · high → 32_000 tokens.
     */
    reasoningEffort?: ReasoningEffort
    /**
     * Per-implementation model override. Lets consumers route specific stages to
     * cheaper or stronger models without forking the profile:
     *
     *   "agent": {
     *     "model": "claude/claude-sonnet-4-6",
     *     "perImplementation": {
     *       "classify":      "claude/claude-haiku-4-5-20251001",
     *       "research":      "claude/claude-haiku-4-5-20251001",
     *       "plan":          "claude/claude-opus-4-7",
     *       "goal-manager":     "claude/claude-haiku-4-5-20251001"
     *     }
     *   }
     *
     * Resolution order in the executor: perImplementation[name] → profile.model
     * (when non-"inherit") → agent.model. Missing entries fall through —
     * existing configs without this key see no behaviour change.
     */
    perImplementation?: Record<string, string>
    /**
     * Per-implementation thinking effort override. Keeps LLM cost/quality tuning
     * attached to the implementation that actually invokes the agent.
     */
    perImplementationReasoningEffort?: Record<string, ReasoningEffort>
  }
  execution?: {
    /** Repository-owned deterministic Capability to Implementation bindings. */
    capabilityBindings: Record<string, string>
  }
  issueContext?: {
    commentLimit?: number
    commentMaxBytes?: number
  }
  testRequirements?: TestRequirement[]
  /**
   * Capability action to invoke when a user triggers bare `@kody`
   * on an issue with no subcommand. Defaults to "run" so a plain issue
   * comment implements the issue directly.
   */
  defaultImplementation?: string
  /**
   * Capability action to invoke when a bare `@kody` lands on a PR.
   * Opt-in: absent means PR comments must name an explicit capability action such as
   * `resolve`, `sync`, or a repo-provided action.
   */
  defaultPrImplementation?: string
  /**
   * Capability action to run on a `pull_request` event whose action is `opened`,
   * `synchronize`, or `reopened` — e.g. "preview-build" to rebuild a per-PR
   * preview on every push to the PR branch.
   *
   * Opt-in: unset → `pull_request` events do nothing (current default).
   * `closed`/`merged` actions are ALWAYS ignored here regardless of this
   * setting — the release orchestrator self-manages its own merge.
   *
   * The dispatched PR number is bound under the target implementation's first
   * required int input (e.g. preview-build's `pr`). This only takes effect
   * when the consumer's kody.yml actually subscribes to `pull_request`
   * (opened/synchronize) — the trigger can only live in YAML, not here.
   */
  onPullRequest?: string
  /**
   * Comment-subcommand aliases: map typed word → implementation name. Merged with
   * built-in compatibility aliases ({ build: "run" }). User entries override
   * built-ins. Dispatch resolves the first token against this map before the
   * registry.
   */
  aliases?: Record<string, string>
  /**
   * Classifier configuration (only honored when bare `@kody` routes to
   * the `classify` implementation). `labelMap` lets you override the built-in
   * label → flow mapping (see src/scripts/classifyByLabel.ts for defaults).
   */
  classify?: {
    labelMap?: Record<string, string>
  }
  release?: {
    versionFiles?: string[]
    publishCommand?: string
    notifyCommand?: string
    e2eCommand?: string
    productionUrl?: string
    smokeCommand?: string
    draftRelease?: boolean
    /**
     * Production target. release-promote opens a PR
     * `git.defaultBranch → releaseBranch` and stops. Unset (or equal to
     * `git.defaultBranch`) → promotion is a no-op success (single-branch repos
     * have nothing to promote).
     */
    releaseBranch?: string
    timeoutMs?: number
  }
  company?: {
    activeCapabilities?: string[]
    activeGoals?: GoalActivation[]
  }
  /**
   * Who may trigger kody via an `@kody` comment. Gates on the GitHub
   * `comment.author_association` already present on the issue_comment event
   * (no API call, no read:org token needed).
   *
   *   unset            → DEFAULT: only the team may trigger, i.e.
   *                      ["OWNER", "MEMBER", "COLLABORATOR"]. Drive-by
   *                      public comments are silently ignored.
   *   non-empty list   → only comments whose author_association is in the
   *                      list run; all others are silently ignored.
   *   explicit []      → gate disabled, anyone may trigger (opt back into
   *                      fully-open behavior).
   *
   * Valid values (GitHub's enum): OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR,
   * FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, MANNEQUIN, NONE. Note MEMBER only
   * applies to org-owned repos; on a user-owned repo the owner is OWNER
   * and invited people are COLLABORATOR.
   */
  access?: {
    allowedAssociations?: string[]
  }
}

export interface ProviderModel {
  provider: string
  model: string
  protocol?: string
  baseURL?: string
  apiKeyEnvVar?: string
  litellmProvider?: string
  spec?: string
}

/**
 * User-facing thinking level. Maps to `maxThinkingTokens` for the Claude
 * Agent SDK. Unset / `"off"` means "no thinking" — the SDK runs without
 * the extended-thinking block, no extra tokens, no reasoning preamble.
 *
 * Resolution order (engine-side, all layers independent):
 *   1. `--reasoning-effort` CLI flag (chat mode only — `kody chat …`)
 *   2. `REASONING_EFFORT` env var (forwarded by the dashboard workflow)
 *   3. `agent.reasoningEffort` in kody.config.json
 *   4. unset → no `maxThinkingTokens` set on the SDK call
 */
export type ReasoningEffort = "off" | "low" | "medium" | "high"

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["off", "low", "medium", "high"] as const

/**
 * Budget mapping. Indices must match REASONING_EFFORTS:
 *   REASONING_BUDGETS[1] === 2048   (low)
 *   REASONING_BUDGETS[2] === 10_000 (medium)
 *   REASONING_BUDGETS[3] === 32_000 (high)
 * Off is implicit — we don't set maxThinkingTokens at all in that case.
 */
export const REASONING_BUDGETS: Record<Exclude<ReasoningEffort, "off">, number> = {
  low: 2_048,
  medium: 10_000,
  high: 32_000,
}

/**
 * Parse a string from the env/CLI into a ReasoningEffort. Returns `null`
 * for unset / unknown — caller should fall through to the next source in
 * the resolution order. Case-insensitive; trims whitespace.
 */
export function parseReasoningEffort(raw: string | null | undefined): ReasoningEffort | null {
  if (!raw) return null
  const v = raw.trim().toLowerCase()
  if (REASONING_EFFORTS.includes(v as ReasoningEffort)) return v as ReasoningEffort
  return null
}

export const LITELLM_DEFAULT_PORT = 4000
export const LITELLM_DEFAULT_URL = `http://localhost:${LITELLM_DEFAULT_PORT}`

export function parseProviderModel(s: string): ProviderModel {
  const slash = s.indexOf("/")
  if (slash <= 0 || slash === s.length - 1) {
    throw new Error(`Invalid model spec '${s}' — expected 'provider/model' (e.g. 'minimax/MiniMax-M3')`)
  }
  return { provider: s.slice(0, slash), model: s.slice(slash + 1) }
}

function optionalRuntimeString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function parseModelRuntimeConfig(modelSpec: string, rawConfig: string | undefined): ProviderModel {
  const fallback = parseProviderModel(modelSpec)
  const raw = rawConfig?.trim()
  if (!raw) return fallback

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`KODY_MODEL_CONFIG is invalid JSON: ${msg}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("KODY_MODEL_CONFIG must be a JSON object")
  }

  const record = parsed as Record<string, unknown>
  const modelName = optionalRuntimeString(record, "modelName")
  if (!modelName) {
    throw new Error("KODY_MODEL_CONFIG.modelName is required")
  }
  const protocol = optionalRuntimeString(record, "protocol")
  const baseURL = optionalRuntimeString(record, "baseURL")
  const apiKeyEnvVar = optionalRuntimeString(record, "apiKeyEnvVar")
  const spec = optionalRuntimeString(record, "spec")
  const provider = optionalRuntimeString(record, "provider") ?? fallback.provider

  const out: ProviderModel = {
    provider,
    model: modelName,
  }
  if (protocol) out.protocol = protocol
  if (baseURL) out.baseURL = baseURL
  if (apiKeyEnvVar) out.apiKeyEnvVar = apiKeyEnvVar
  if (spec) out.spec = spec
  if (protocol === "openai") out.litellmProvider = "openai"
  return out
}

export function litellmModelGroup(model: ProviderModel): string {
  return model.spec?.trim() || model.model
}

export function providerApiKeyEnvVar(provider: string): string {
  if (provider === "anthropic" || provider === "claude") return "ANTHROPIC_API_KEY"
  return `${provider.toUpperCase()}_API_KEY`
}

export function needsLitellmProxy(model: ProviderModel): boolean {
  if (model.protocol === "anthropic") return false
  return model.provider !== "claude" && model.provider !== "anthropic"
}

export function loadConfig(projectDir: string = process.cwd()): KodyConfig {
  const configPath = path.join(projectDir, "kody.config.json")
  if (!fs.existsSync(configPath)) {
    throw new Error(`kody.config.json not found at ${configPath}`)
  }

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`kody.config.json is invalid JSON: ${msg}`)
  }

  const quality = recordValue(raw.quality) ?? {}
  const git = recordValue(raw.git) ?? {}
  const github = recordValue(raw.github) ?? {}
  const agent = recordValue(raw.agent) ?? {}

  if (!agent.model || typeof agent.model !== "string") {
    throw new Error(`kody.config.json: agent.model is required (e.g. "minimax/MiniMax-M3")`)
  }
  if (!github.owner || !github.repo) {
    throw new Error(`kody.config.json: github.owner and github.repo are required`)
  }

  return {
    quality: {
      typecheck: typeof quality.typecheck === "string" ? quality.typecheck : "",
      lint: typeof quality.lint === "string" ? quality.lint : "",
      format: typeof quality.format === "string" ? quality.format : "",
      testUnit: typeof quality.testUnit === "string" ? quality.testUnit : "",
    },
    git: {
      defaultBranch: typeof git.defaultBranch === "string" ? git.defaultBranch : "main",
    },
    github: {
      owner: String(github.owner),
      repo: String(github.repo),
    },
    agent: {
      model: String(agent.model),
      ...parsePerImplementation(agent.perImplementation),
      ...parsePerImplementationReasoningEffort(agent.perImplementationReasoningEffort),
      ...parseAgentReasoningEffort(agent.reasoningEffort),
    },
    execution: parseExecutionConfig(raw.execution),
    issueContext: parseIssueContext(raw.issueContext),
    testRequirements: parseTestRequirements(raw.testRequirements),
    defaultImplementation:
      typeof raw.defaultImplementation === "string" && raw.defaultImplementation.length > 0
        ? raw.defaultImplementation
        : "run",
    defaultPrImplementation:
      typeof raw.defaultPrImplementation === "string" && raw.defaultPrImplementation.length > 0
        ? raw.defaultPrImplementation
        : undefined,
    onPullRequest:
      typeof raw.onPullRequest === "string" && raw.onPullRequest.length > 0 ? raw.onPullRequest : undefined,
    aliases: mergeAliases(raw.aliases),
    classify: parseClassifyConfig(raw.classify),
    release: parseReleaseConfig(raw.release),
    company: parseCompanyConfig(raw.company),
    access: parseAccessConfig(raw.access),
  }
}

function parseExecutionConfig(value: unknown): KodyConfig["execution"] {
  const execution = recordValue(value)
  const bindings = recordValue(execution?.capabilityBindings)
  if (!bindings) return undefined
  const capabilityBindings: Record<string, string> = {}
  for (const [capabilityId, implementationId] of Object.entries(bindings)) {
    if (
      /^[a-z][a-z0-9-]*$/.test(capabilityId) &&
      typeof implementationId === "string" &&
      /^[a-z][a-z0-9-]*$/.test(implementationId)
    ) {
      capabilityBindings[capabilityId] = implementationId
    }
  }
  return Object.keys(capabilityBindings).length > 0 ? { capabilityBindings } : undefined
}

/**
 * GitHub's `author_association` enum. Used to validate access.allowedAssociations
 * so a typo (e.g. "MEMBERS") fails loudly at config load rather than silently
 * locking everyone out at dispatch time.
 */
export const GITHUB_AUTHOR_ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
] as const

/**
 * Default trigger allowlist applied when `access` is omitted: the team only
 * (repo/org owner, org members, invited collaborators). Public drive-by
 * commenters (CONTRIBUTOR/NONE/…) are silently ignored. Consumers reopen
 * to everyone with an explicit `access.allowedAssociations: []`.
 */
export const DEFAULT_ALLOWED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"] as const

function parseAccessConfig(raw: unknown): KodyConfig["access"] {
  // Omitted → secure-by-default team-only gate.
  if (raw === undefined || raw === null) {
    return { allowedAssociations: [...DEFAULT_ALLOWED_ASSOCIATIONS] }
  }
  if (typeof raw !== "object") {
    throw new Error(`kody.config.json: access must be an object`)
  }
  const r = raw as Record<string, unknown>
  // `access` present but no allowlist key → still apply the default.
  if (r.allowedAssociations === undefined) {
    return { allowedAssociations: [...DEFAULT_ALLOWED_ASSOCIATIONS] }
  }
  if (!Array.isArray(r.allowedAssociations)) {
    throw new Error(`kody.config.json: access.allowedAssociations must be an array of strings`)
  }
  const valid = new Set<string>(GITHUB_AUTHOR_ASSOCIATIONS)
  const out: string[] = []
  for (const v of r.allowedAssociations) {
    if (typeof v !== "string") {
      throw new Error(`kody.config.json: access.allowedAssociations entries must be strings`)
    }
    const up = v.trim().toUpperCase()
    if (!valid.has(up)) {
      throw new Error(
        `kody.config.json: access.allowedAssociations contains "${v}" — must be one of ${GITHUB_AUTHOR_ASSOCIATIONS.join(", ")}`,
      )
    }
    out.push(up)
  }
  // Explicit empty list → gate disabled (open to everyone). Distinct from
  // "unset", which defaults to team-only above. dispatch treats a
  // zero-length allowlist as "no gate".
  return { allowedAssociations: out }
}

function parseCompanyConfig(raw: unknown): KodyConfig["company"] {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const out: NonNullable<KodyConfig["company"]> = {}
  if (r.activeCapabilities !== undefined)
    out.activeCapabilities = parseSlugArray(r.activeCapabilities, "company.activeCapabilities")
  if (r.activeGoals !== undefined) out.activeGoals = parseGoalActivations(r.activeGoals)
  return Object.keys(out).length > 0 ? out : undefined
}

function parseGoalActivations(raw: unknown): GoalActivation[] {
  if (!Array.isArray(raw)) throw new Error(`kody.config.json: company.activeGoals must be an array`)
  const out: GoalActivation[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (typeof value === "string") {
      const slug = parseSlug(value, "company.activeGoals")
      if (!slug) continue
      if (!seen.has(slug)) {
        seen.add(slug)
        out.push(slug)
      }
      continue
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`kody.config.json: company.activeGoals entries must be strings or goal schedule objects`)
    }

    const r = value as Record<string, unknown>
    const template = typeof r.template === "string" ? parseSlug(r.template, "company.activeGoals.template") : ""
    if (!template) throw new Error(`kody.config.json: company.activeGoals object requires template`)

    const entry: ScheduledGoalActivation = { template }
    if (r.every !== undefined) {
      if (typeof r.every !== "string" || !/^[1-9][0-9]*[mhdw]$/.test(r.every.trim())) {
        throw new Error(`kody.config.json: company.activeGoals every must look like "1d", "1w", "15m", or "2h"`)
      }
      entry.every = r.every.trim()
    }
    if (r.idPrefix !== undefined) {
      if (typeof r.idPrefix !== "string")
        throw new Error(`kody.config.json: company.activeGoals idPrefix must be a string`)
      const idPrefix = parseSlug(r.idPrefix, "company.activeGoals.idPrefix")
      if (idPrefix) entry.idPrefix = idPrefix
    }
    if (r.preferredRunTime !== undefined) {
      const preferredRunTime = parsePreferredRunTime(r.preferredRunTime)
      if (!preferredRunTime)
        throw new Error(
          `kody.config.json: company.activeGoals preferredRunTime must be { "time": "HH:MM", "timezone": "Area/Name" }`,
        )
      entry.preferredRunTime = preferredRunTime
    }
    const facts = recordValue(r.facts)
    if (r.facts !== undefined && !facts)
      throw new Error(`kody.config.json: company.activeGoals facts must be an object`)
    if (facts) entry.facts = facts
    out.push(entry)
  }
  return out
}

function parsePreferredRunTime(raw: unknown): { time: string; timezone: string } | null {
  const r = recordValue(raw)
  if (!r) return null
  if (typeof r.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time.trim())) return null
  if (typeof r.timezone !== "string" || !r.timezone.trim()) return null
  return { time: r.time.trim(), timezone: r.timezone.trim() }
}

function parseSlugArray(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`kody.config.json: ${field} must be an array of strings`)
  const out: string[] = []
  for (const value of raw) {
    const slug = parseSlug(value, field)
    if (!slug) continue
    out.push(slug)
  }
  return [...new Set(out)]
}

function parseSlug(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`kody.config.json: ${field} entries must be strings`)
  const slug = value.trim()
  if (!slug) return ""
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
    throw new Error(`kody.config.json: ${field} contains invalid slug "${value}"`)
  }
  return slug
}

function recordValue(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
}

/**
 * Legacy comment-subcommand aliases, always merged into config.aliases.
 * Exported so dispatch can use them as a fallback when called without a
 * loaded config (e.g. from tests).
 */
export const BUILTIN_ALIASES: Record<string, string> = {
  build: "run",
}

function mergeAliases(raw: unknown): Record<string, string> {
  const out: Record<string, string> = { ...BUILTIN_ALIASES }
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) out[k.toLowerCase()] = v
    }
  }
  return out
}

/**
 * Parse `agent.perImplementation` into a validated string→string map, spread into
 * the returned `agent` object. Returns `{}` (not `{ perImplementation: undefined }`)
 * when absent so the spread is a clean no-op and the key stays off the object.
 * Without this, the executor's `config.agent.perImplementation?.[name]` lookup is
 * always undefined and every stage silently runs the base model.
 */
function parsePerImplementation(raw: unknown): { perImplementation?: Record<string, string> } {
  if (!raw || typeof raw !== "object") return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) out[k] = v
  }
  return Object.keys(out).length > 0 ? { perImplementation: out } : {}
}

function parsePerImplementationReasoningEffort(raw: unknown): {
  perImplementationReasoningEffort?: Record<string, ReasoningEffort>
} {
  if (!raw || typeof raw !== "object") return {}
  const out: Record<string, ReasoningEffort> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const effort = typeof v === "string" ? parseReasoningEffort(v) : null
    if (effort) out[k] = effort
  }
  return Object.keys(out).length > 0 ? { perImplementationReasoningEffort: out } : {}
}

/**
 * Normalize `agent.reasoningEffort` from the raw config. Unknown / empty
 * values drop to undefined so the engine falls through to the next
 * resolution source (env var → CLI flag → unset). Forward-compatible:
 * when a new level is added in the future, older engine versions
 * silently ignore it instead of crashing on the new value.
 */
function parseAgentReasoningEffort(raw: unknown): { reasoningEffort?: ReasoningEffort } {
  if (typeof raw !== "string") return {}
  return { reasoningEffort: parseReasoningEffort(raw) ?? undefined }
}

function parseClassifyConfig(raw: unknown): KodyConfig["classify"] {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const out: NonNullable<KodyConfig["classify"]> = {}
  if (r.labelMap && typeof r.labelMap === "object") {
    const entries = Object.entries(r.labelMap as Record<string, unknown>).filter(
      ([, v]) => typeof v === "string" && (v as string).length > 0,
    )
    if (entries.length > 0) {
      out.labelMap = Object.fromEntries(entries.map(([k, v]) => [k.toLowerCase(), String(v)]))
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function parseReleaseConfig(raw: unknown): KodyConfig["release"] {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const out: NonNullable<KodyConfig["release"]> = {}
  if (Array.isArray(r.versionFiles)) out.versionFiles = r.versionFiles.filter((f): f is string => typeof f === "string")
  if (typeof r.publishCommand === "string") out.publishCommand = r.publishCommand
  if (typeof r.notifyCommand === "string") out.notifyCommand = r.notifyCommand
  if (typeof r.e2eCommand === "string") out.e2eCommand = r.e2eCommand
  if (typeof r.productionUrl === "string") out.productionUrl = r.productionUrl
  if (typeof r.smokeCommand === "string") out.smokeCommand = r.smokeCommand
  if (typeof r.draftRelease === "boolean") out.draftRelease = r.draftRelease
  if (typeof r.releaseBranch === "string") out.releaseBranch = r.releaseBranch
  if (typeof r.timeoutMs === "number" && r.timeoutMs > 0) out.timeoutMs = Math.floor(r.timeoutMs)
  return Object.keys(out).length > 0 ? out : undefined
}

function parseIssueContext(raw: unknown): KodyConfig["issueContext"] {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as { commentLimit?: unknown; commentMaxBytes?: unknown }
  const out: NonNullable<KodyConfig["issueContext"]> = {}
  if (typeof r.commentLimit === "number" && r.commentLimit > 0) out.commentLimit = Math.floor(r.commentLimit)
  if (typeof r.commentMaxBytes === "number" && r.commentMaxBytes > 0)
    out.commentMaxBytes = Math.floor(r.commentMaxBytes)
  return Object.keys(out).length > 0 ? out : undefined
}

function parseTestRequirements(raw: unknown): TestRequirement[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: TestRequirement[] = []
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { pattern?: unknown }).pattern === "string" &&
      typeof (item as { requireSibling?: unknown }).requireSibling === "string"
    ) {
      out.push({
        pattern: (item as { pattern: string }).pattern,
        requireSibling: (item as { requireSibling: string }).requireSibling,
      })
    }
  }
  return out.length > 0 ? out : undefined
}

export function getAnthropicApiKeyOrDummy(): string {
  return process.env.ANTHROPIC_API_KEY || `sk-ant-api03-${"0".repeat(64)}`
}
