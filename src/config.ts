import * as fs from "node:fs"
import * as path from "node:path"

export interface TestRequirement {
  pattern: string
  requireSibling: string
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
     * Per-executable model override. Lets consumers route specific stages to
     * cheaper or stronger models without forking the profile:
     *
     *   "agent": {
     *     "model": "claude/claude-sonnet-4-6",
     *     "perExecutable": {
     *       "classify":      "claude/claude-haiku-4-5-20251001",
     *       "research":      "claude/claude-haiku-4-5-20251001",
     *       "plan":          "claude/claude-opus-4-7",
     *       "goal-tick":     "claude/claude-haiku-4-5-20251001"
     *     }
     *   }
     *
     * Resolution order in the executor: perExecutable[name] → profile.model
     * (when non-"inherit") → agent.model. Missing entries fall through —
     * existing configs without this key see no behaviour change.
     */
    perExecutable?: Record<string, string>
  }
  issueContext?: {
    commentLimit?: number
    commentMaxBytes?: number
  }
  testRequirements?: TestRequirement[]
  /**
   * Executable name to invoke when a user triggers bare `@kody` with no
   * subcommand. Defaults to "classify" (auto-triages into one of {feature,
   * bug, spec, chore} before dispatching). Set to "run" to skip classification
   * and directly implement, or "bug"/"feature" to force a specific
   * sub-orchestrator. The default is baked in by `loadConfig` so dispatch
   * has a single source of truth — never hardcoded in dispatch logic.
   */
  defaultExecutable?: string
  /**
   * Executable to run when a bare/unrecognized `@kody <rest>` lands on a PR.
   * Defaults to "fix" — legacy behavior: any PR comment without a known
   * subcommand becomes a fix with the comment body as feedback.
   */
  defaultPrExecutable?: string
  /**
   * Comment-subcommand aliases: map typed word → executable name. Merged
   * with built-in legacy aliases ({ build: "run", orchestrate: "bug",
   * orchestrator: "bug" }). User entries override built-ins. Dispatch
   * resolves the first token against this map before the registry, so
   * every name dispatch knows lives here, not in code.
   */
  aliases?: Record<string, string>
  /**
   * Classifier configuration (only honored when bare `@kody` routes to
   * the `classify` executable). `labelMap` lets you override the built-in
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
    draftRelease?: boolean
    /**
     * Production target. release-deploy opens a PR
     * `git.defaultBranch → releaseBranch` and stops. Unset (or equal to
     * `git.defaultBranch`) → deploy is a no-op success (single-branch repos
     * have nothing to promote).
     */
    releaseBranch?: string
    timeoutMs?: number
  }
  jobs?: {
    /**
     * Storage backend for file-based job state.
     *   "contents-api" (default) — durable tracked file, one commit per change.
     *   "local-file"             — on-disk file, snapshotted to GitHub Actions
     *                              cache between workflow runs. Eliminates
     *                              commit churn but is bound to the cache
     *                              lifecycle (evicted after 7 days idle).
     */
    stateBackend?: "contents-api" | "local-file"
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
}

export const LITELLM_DEFAULT_PORT = 4000
export const LITELLM_DEFAULT_URL = `http://localhost:${LITELLM_DEFAULT_PORT}`

export function parseProviderModel(s: string): ProviderModel {
  const slash = s.indexOf("/")
  if (slash <= 0 || slash === s.length - 1) {
    throw new Error(`Invalid model spec '${s}' — expected 'provider/model' (e.g. 'minimax/MiniMax-M2.7-highspeed')`)
  }
  return { provider: s.slice(0, slash), model: s.slice(slash + 1) }
}

export function providerApiKeyEnvVar(provider: string): string {
  if (provider === "anthropic" || provider === "claude") return "ANTHROPIC_API_KEY"
  return `${provider.toUpperCase()}_API_KEY`
}

export function needsLitellmProxy(model: ProviderModel): boolean {
  return model.provider !== "claude" && model.provider !== "anthropic"
}

export function loadConfig(projectDir: string = process.cwd()): KodyConfig {
  const configPath = path.join(projectDir, "kody.config.json")
  if (!fs.existsSync(configPath)) {
    throw new Error(`kody.config.json not found at ${configPath}`)
  }

  let raw: Record<string, any>
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`kody.config.json is invalid JSON: ${msg}`)
  }

  const quality = raw.quality ?? {}
  const git = raw.git ?? {}
  const github = raw.github ?? {}
  const agent = raw.agent ?? {}

  if (!agent.model || typeof agent.model !== "string") {
    throw new Error(`kody.config.json: agent.model is required (e.g. "minimax/MiniMax-M2.7-highspeed")`)
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
      ...(parsePerExecutable(agent.perExecutable)),
    },
    issueContext: parseIssueContext(raw.issueContext),
    testRequirements: parseTestRequirements(raw.testRequirements),
    defaultExecutable:
      typeof raw.defaultExecutable === "string" && raw.defaultExecutable.length > 0
        ? raw.defaultExecutable
        : "run",
    defaultPrExecutable:
      typeof raw.defaultPrExecutable === "string" && raw.defaultPrExecutable.length > 0
        ? raw.defaultPrExecutable
        : "fix",
    aliases: mergeAliases(raw.aliases),
    classify: parseClassifyConfig(raw.classify),
    release: parseReleaseConfig(raw.release),
    jobs: parseJobsConfig(raw.jobs),
    access: parseAccessConfig(raw.access),
  }
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

function parseJobsConfig(raw: unknown): KodyConfig["jobs"] {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const out: NonNullable<KodyConfig["jobs"]> = {}
  if (r.stateBackend === "contents-api" || r.stateBackend === "local-file") {
    out.stateBackend = r.stateBackend
  } else if (typeof r.stateBackend === "string") {
    throw new Error(
      `kody.config.json: jobs.stateBackend must be "contents-api" or "local-file", got "${r.stateBackend}"`,
    )
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Legacy comment-subcommand aliases, always merged into config.aliases.
 * Exported so dispatch can use them as a fallback when called without a
 * loaded config (e.g. from tests).
 */
export const BUILTIN_ALIASES: Record<string, string> = {
  build: "run",
  orchestrate: "bug",
  orchestrator: "bug",
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
 * Parse `agent.perExecutable` into a validated string→string map, spread into
 * the returned `agent` object. Returns `{}` (not `{ perExecutable: undefined }`)
 * when absent so the spread is a clean no-op and the key stays off the object.
 * Without this, the executor's `config.agent.perExecutable?.[name]` lookup is
 * always undefined and every stage silently runs the base model.
 */
function parsePerExecutable(raw: unknown): { perExecutable?: Record<string, string> } {
  if (!raw || typeof raw !== "object") return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) out[k] = v
  }
  return Object.keys(out).length > 0 ? { perExecutable: out } : {}
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
