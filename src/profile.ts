/**
 * Profile loader + validator.
 *
 * Reads an agentAction profile.json from disk, applies permissive defaults,
 * and checks invariants (every referenced script exists in the registry,
 * every input spec is well-formed, etc.). The executor treats a loaded
 * Profile as trustworthy.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type {
  CapabilityKind,
  ClaudeCodeSpec,
  CliToolSpec,
  ContainerChild,
  InputArtifactSpec,
  InputSpec,
  OutputArtifactSpec,
  Profile,
  ScriptEntry,
} from "./agent-actions/types.js"
import { AGENT_RESPONSIBILITY_MCP_TOOL_NAMES } from "./agent-responsibilityMcp.js"
import { parseReasoningEffort } from "./config.js"
import { applyLifecycle } from "./lifecycles/index.js"
import { ProfileError } from "./profile-error.js"
import { resolveAgentAction } from "./registry.js"
import { captureSubagentTemplates } from "./subagents.js"

export { ProfileError } from "./profile-error.js"

const VALID_INPUT_TYPES = new Set(["int", "string", "bool", "enum"])
const VALID_PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions"])
const VALID_ROLES = new Set(["primitive", "orchestrator", "container", "watch", "utility"])
const VALID_CONTAINER_CHILD_TARGETS = new Set(["issue", "pr"])
const VALID_PHASES = new Set(["research", "planning", "implementing", "reviewing", "shipped", "failed", "idle"])
const VALID_CAPABILITY_KINDS = new Set(["observe", "act", "verify"])

/**
 * Top-level profile keys that the loader understands. Unknown keys are
 * warned about on load so typos like `clude_code` or `mcpServer` surface
 * immediately instead of being silently dropped. Warnings are non-fatal
 * — operators can still ship a profile with experimental fields.
 */
const KNOWN_PROFILE_KEYS = new Set([
  "name",
  "action",
  "agentAction",
  "agent",
  "every",
  "agentResponsibilityTools",
  "tools",
  "mentions",
  "capabilityKind",
  "stage",
  "readsFrom",
  "writesTo",
  "describe",
  "role",
  "kind",
  "schedule",
  "phase",
  "inputs",
  "claudeCode",
  "cliTools",
  "lifecycle",
  "lifecycleConfig",
  "scripts",
  "outputContract",
  "inputArtifacts",
  "outputArtifacts",
  "input", // legacy JSON name for inputArtifacts source
  "output", // legacy JSON name for outputArtifacts source
  "children",
  "resetBetweenChildren",
  "preloadContext",
])

export function loadProfile(profilePath: string): Profile {
  if (!fs.existsSync(profilePath)) {
    throw new ProfileError(profilePath, "file not found")
  }

  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(profilePath, "utf-8"))
  } catch (err) {
    throw new ProfileError(profilePath, `invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!raw || typeof raw !== "object") {
    throw new ProfileError(profilePath, "profile must be a JSON object")
  }

  const r = raw as Record<string, unknown>

  // Phase 4g: surface unknown top-level keys. Silently-dropped typos in
  // profile.json (e.g. `mcpServer` instead of `mcpServers` at the wrong
  // level, or experimental `cacheabl` instead of `cacheable`) used to be
  // invisible because the loader ignored anything it didn't recognise.
  // Non-fatal so consumer repos can stage experimental fields, but loud
  // enough that operators see the warning in GHA logs.
  const unknownKeys = Object.keys(r).filter((k) => !KNOWN_PROFILE_KEYS.has(k))
  if (unknownKeys.length > 0) {
    process.stderr.write(
      `[kody profile] ${path.basename(path.dirname(profilePath))}: unknown top-level keys ignored: ${unknownKeys.join(", ")}\n`,
    )
  }

  // AgentResponsibility-as-reference: a agentResponsibility names an agentAction (the HOW) instead of embedding
  // it. Resolve that agentAction's full profile and overlay this agentResponsibility's identity
  // (name) + agent (WHO) + mentions. The agentResponsibility folder then
  // thin binding — no claudeCode/prompt/scripts of its own.
  // agentAction = how, agent = who, agentResponsibility = why.
  const execRef = typeof r.agentAction === "string" ? r.agentAction.trim() : ""
  if (execRef) {
    const refPath = resolveAgentAction(execRef)
    if (!refPath) {
      throw new ProfileError(profilePath, `agentResponsibility references unknown agentAction '${execRef}'`)
    }
    const base = loadProfile(refPath)
    return {
      ...base,
      name: requireString(profilePath, r, "name"),
      action: typeof r.action === "string" && r.action.trim() ? r.action.trim() : undefined,
      agentAction: execRef,
      describe: typeof r.describe === "string" ? r.describe : base.describe,
      capabilityKind: parseCapabilityKind(profilePath, r.capabilityKind) ?? base.capabilityKind,
      agent: typeof r.agent === "string" && r.agent.trim() ? r.agent.trim() : base.agent,
      agentResponsibilityTools:
        parseStringArray(r.agentResponsibilityTools ?? r.tools) ?? base.agentResponsibilityTools,
      mentions: Array.isArray(r.mentions)
        ? (r.mentions as string[]).map((m) => String(m).trim()).filter(Boolean)
        : base.mentions,
    }
  }

  const kind = r.kind === "scheduled" ? "scheduled" : "oneshot"
  if (kind === "scheduled" && typeof r.schedule !== "string") {
    throw new ProfileError(profilePath, `kind: "scheduled" requires a "schedule" cron string`)
  }

  if (typeof r.role !== "string" || !VALID_ROLES.has(r.role)) {
    throw new ProfileError(profilePath, `"role" is required and must be one of: ${[...VALID_ROLES].join(" | ")}`)
  }
  const role = r.role as Profile["role"]

  let phase: Profile["phase"]
  if (r.phase !== undefined) {
    if (typeof r.phase !== "string" || !VALID_PHASES.has(r.phase)) {
      throw new ProfileError(profilePath, `"phase" must be one of: ${[...VALID_PHASES].join(" | ")}`)
    }
    phase = r.phase as Profile["phase"]
  }

  const children = parseContainerChildren(profilePath, role, r.children)

  let lifecycle: string | undefined
  if (r.lifecycle !== undefined) {
    if (typeof r.lifecycle !== "string" || r.lifecycle.length === 0) {
      throw new ProfileError(profilePath, `"lifecycle" must be a non-empty string`)
    }
    lifecycle = r.lifecycle
  }

  let lifecycleConfig: Record<string, unknown> | undefined
  if (r.lifecycleConfig !== undefined) {
    if (!r.lifecycleConfig || typeof r.lifecycleConfig !== "object" || Array.isArray(r.lifecycleConfig)) {
      throw new ProfileError(profilePath, `"lifecycleConfig" must be an object`)
    }
    lifecycleConfig = r.lifecycleConfig as Record<string, unknown>
  }

  if (lifecycleConfig && !lifecycle) {
    throw new ProfileError(profilePath, `"lifecycleConfig" is only meaningful when "lifecycle" is set`)
  }

  const profile: Profile = {
    name: requireString(profilePath, r, "name"),
    action: typeof r.action === "string" && r.action.trim() ? r.action.trim() : undefined,
    agentAction: undefined,
    describe: typeof r.describe === "string" ? r.describe : "",
    capabilityKind: parseCapabilityKind(profilePath, r.capabilityKind),
    // Optional agent to run as. Empty/blank string → undefined (no agent).
    agent: typeof r.agent === "string" && r.agent.trim() ? r.agent.trim() : undefined,
    // Locked-toolbox palette + mentions from folder-agentResponsibility profile metadata.
    agentResponsibilityTools: parseStringArray(r.agentResponsibilityTools ?? r.tools),
    mentions: Array.isArray(r.mentions)
      ? (r.mentions as string[]).map((m) => String(m).trim()).filter(Boolean)
      : undefined,
    role,
    kind,
    schedule: typeof r.schedule === "string" ? r.schedule : undefined,
    phase,
    inputs: parseInputs(profilePath, r.inputs),
    claudeCode: parseClaudeCode(profilePath, r.claudeCode),
    cliTools: parseCliTools(profilePath, r.cliTools),
    lifecycle,
    lifecycleConfig,
    scripts: parseScripts(profilePath, r.scripts),
    outputContract: r.outputContract as Profile["outputContract"],
    inputArtifacts: parseInputArtifacts(profilePath, r.input),
    outputArtifacts: parseOutputArtifacts(profilePath, r.output),
    children,
    // Default true: preserves legacy bug-safe behaviour where each
    // container child sees a clean tracked tree (see executor.ts).
    // Containers opt out by setting `"resetBetweenChildren": false`.
    resetBetweenChildren: typeof r.resetBetweenChildren === "boolean" ? r.resetBetweenChildren : true,
    // Phase 5 in-process handoff opt-in. Default false; containers
    // flip to true after end-to-end verification.
    preloadContext: r.preloadContext === true,
    dir: path.dirname(profilePath),
    promptTemplates: readPromptTemplates(path.dirname(profilePath)),
  }

  if (lifecycle) {
    applyLifecycle(profile, profilePath)
  }

  // Fail-fast at load (profile.json is static):
  // a agentResponsibilityTools typo should be caught here, not at the agentResponsibility's first run.
  if (profile.agentResponsibilityTools && profile.agentResponsibilityTools.length > 0) {
    const palette = new Set<string>(AGENT_RESPONSIBILITY_MCP_TOOL_NAMES)
    const unknown = profile.agentResponsibilityTools.filter((t) => !palette.has(t))
    if (unknown.length > 0) {
      throw new ProfileError(
        profilePath,
        `agentResponsibilityTools not in the kody-agentResponsibility palette: ${unknown.join(", ")}. Available: ${[...AGENT_RESPONSIBILITY_MCP_TOOL_NAMES].join(", ")}`,
      )
    }
  }

  // State-script pairing: writeJobStateFile/parseJobStateFromAgentResult read
  // ctx.data.jobState, which only a state loader (loadAgentResponsibilityState or
  // loadJobFromFile) sets. Declaring the save half without the load half throws
  // at run time — catch the misconfig at load instead.
  const preNames = new Set(profile.scripts.preflight.map((e) => e.script).filter(Boolean))
  const postNames = profile.scripts.postflight.map((e) => e.script).filter(Boolean)
  const needsState = postNames.includes("writeJobStateFile") || postNames.includes("parseJobStateFromAgentResult")
  // Any of these preflights populate ctx.data.jobState: loadAgentResponsibilityState (folder
  // agentResponsibility), loadJobFromFile (markdown agentResponsibility via agent-responsibility-tick), runTickScript (scripted
  // agentResponsibility via agent-responsibility-tick-scripted).
  const STATE_LOADERS = [
    "loadAgentResponsibilityState",
    "loadJobFromFile",
    "runTickScript",
    "runScheduledAgentActionTick",
  ]
  if (needsState && !STATE_LOADERS.some((s) => preNames.has(s))) {
    throw new ProfileError(
      profilePath,
      `postflight uses writeJobStateFile/parseJobStateFromAgentResult but no state loader (${STATE_LOADERS.join(" | ")}) is declared in preflight`,
    )
  }

  // Snapshot declared subagents now, on the default checkout, so they survive a
  // later task-branch switch that may drop the agentResponsibility's agents/ dir.
  profile.subagentTemplates = captureSubagentTemplates(profile)

  return profile
}

/**
 * Capture a profile's prompt template files at load time — `prompt.md`,
 * folder-agentResponsibility `agent-responsibility.md`, and any `prompts/*.md` — keyed by absolute path.
 * Done here (alongside reading profile.json, before any preflight) so the
 * templates are safe from working-tree churn later in the run
 * (see Profile.promptTemplates). Best-effort: missing files are simply absent.
 */
function readPromptTemplates(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const read = (p: string): void => {
    try {
      out[p] = fs.readFileSync(p, "utf-8")
    } catch {
      /* not present — fine */
    }
  }
  read(path.join(dir, "prompt.md"))
  read(path.join(dir, "agent-responsibility.md"))
  try {
    const promptsDir = path.join(dir, "prompts")
    for (const ent of fs.readdirSync(promptsDir)) {
      if (ent.endsWith(".md")) read(path.join(promptsDir, ent))
    }
  } catch {
    /* no prompts/ dir — fine */
  }
  return out
}

/**
 * Second-pass validation that every TS script referenced by the profile is
 * registered. Shell-script entries skip this check — their existence is
 * verified at invocation time by the executor.
 */
export function validateScriptReferences(profile: Profile, registeredScripts: Set<string>): string[] {
  const missing: string[] = []
  for (const e of [...profile.scripts.preflight, ...profile.scripts.postflight]) {
    if (e.script && !registeredScripts.has(e.script)) missing.push(e.script)
  }
  return missing
}

// ────────────────────────────────────────────────────────────────────────────

function requireString(p: string, r: Record<string, unknown>, key: string): string {
  const v = r[key]
  if (typeof v !== "string" || v.length === 0) {
    throw new ProfileError(p, `"${key}" must be a non-empty string`)
  }
  return v
}

function parseCapabilityKind(p: string, raw: unknown): CapabilityKind | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (typeof raw !== "string" || !VALID_CAPABILITY_KINDS.has(raw)) {
    throw new ProfileError(p, `"capabilityKind" must be one of: observe | act | verify`)
  }
  return raw as CapabilityKind
}

function parseStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const values = raw.map((t) => String(t).trim()).filter(Boolean)
  return values.length > 0 ? values : undefined
}

function parseInputs(p: string, raw: unknown): InputSpec[] {
  if (!Array.isArray(raw)) throw new ProfileError(p, `"inputs" must be an array`)
  const out: InputSpec[] = []
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") {
      throw new ProfileError(p, `inputs[${i}] must be an object`)
    }
    const r = item as Record<string, unknown>
    const name = requireString(p, r, "name")
    const flag = requireString(p, r, "flag")
    const type = requireString(p, r, "type") as InputSpec["type"]
    if (!VALID_INPUT_TYPES.has(type)) {
      throw new ProfileError(p, `inputs[${i}].type must be one of int|string|bool|enum`)
    }
    const spec: InputSpec = {
      name,
      flag,
      type,
      describe: typeof r.describe === "string" ? r.describe : "",
    }
    if (type === "enum") {
      if (!Array.isArray(r.values) || r.values.length === 0) {
        throw new ProfileError(p, `inputs[${i}] (enum) requires non-empty "values" array`)
      }
      spec.values = r.values as string[]
    }
    if (typeof r.required === "boolean") spec.required = r.required
    if (r.requiredWhen && typeof r.requiredWhen === "object") {
      spec.requiredWhen = r.requiredWhen as InputSpec["requiredWhen"]
    }
    if (r.bindsCommentRest === true) spec.bindsCommentRest = true
    out.push(spec)
  }
  return out
}

function parseClaudeCode(p: string, raw: unknown): ClaudeCodeSpec {
  if (!raw || typeof raw !== "object") {
    throw new ProfileError(p, `"claudeCode" must be an object`)
  }
  const r = raw as Record<string, unknown>

  const permissionMode = (
    typeof r.permissionMode === "string" ? r.permissionMode : "acceptEdits"
  ) as ClaudeCodeSpec["permissionMode"]
  if (!VALID_PERMISSION_MODES.has(permissionMode)) {
    throw new ProfileError(p, `claudeCode.permissionMode must be one of default|acceptEdits|plan|bypassPermissions`)
  }

  const tools = Array.isArray(r.tools) ? (r.tools as string[]) : []
  // An empty tools array is permitted for configless / agentless agentActions
  // (e.g. `init`, `release`). Such agentActions must set ctx.skipAgent in a
  // preflight script — the executor refuses to invoke the agent without tools
  // and without skipAgent, surfacing the misconfiguration loudly.

  return {
    model: typeof r.model === "string" ? r.model : "inherit",
    permissionMode,
    maxTurns: typeof r.maxTurns === "number" ? r.maxTurns : null,
    maxThinkingTokens: typeof r.maxThinkingTokens === "number" ? r.maxThinkingTokens : null,
    reasoningEffort: typeof r.reasoningEffort === "string" ? parseReasoningEffort(r.reasoningEffort) : null,
    maxTurnTimeoutSec: typeof r.maxTurnTimeoutSec === "number" ? r.maxTurnTimeoutSec : null,
    systemPromptAppend: typeof r.systemPromptAppend === "string" ? r.systemPromptAppend : null,
    cacheable: r.cacheable === true,
    enableVerifyTool: r.enableVerifyTool === true,
    enableSubmitTool: r.enableSubmitTool === true,
    verifyAttempts: typeof r.verifyAttempts === "number" && r.verifyAttempts > 0 ? r.verifyAttempts : null,
    tools,
    hooks: Array.isArray(r.hooks) ? (r.hooks as string[]) : [],
    skills: Array.isArray(r.skills) ? (r.skills as string[]) : [],
    commands: Array.isArray(r.commands) ? (r.commands as string[]) : [],
    subagents: Array.isArray(r.subagents) ? (r.subagents as string[]) : [],
    plugins: Array.isArray(r.plugins) ? (r.plugins as string[]) : [],
    mcpServers: Array.isArray(r.mcpServers) ? (r.mcpServers as ClaudeCodeSpec["mcpServers"]) : [],
  }
}

function parseCliTools(p: string, raw: unknown): CliToolSpec[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new ProfileError(p, `"cliTools" must be an array or absent`)
  const out: CliToolSpec[] = []
  for (const [i, item] of raw.entries()) {
    if (typeof item === "string" && item.trim()) {
      const name = item.trim()
      out.push({
        name,
        install: { required: false, checkCommand: `command -v ${name}` },
        verify: `command -v ${name}`,
        usage: "",
        allowedUses: [],
      })
      continue
    }
    if (!item || typeof item !== "object") {
      throw new ProfileError(p, `cliTools[${i}] must be an object`)
    }
    const r = item as Record<string, unknown>
    const install = r.install as Record<string, unknown> | undefined
    if (!install || typeof install !== "object") {
      throw new ProfileError(p, `cliTools[${i}].install must be an object`)
    }
    out.push({
      name: requireString(p, r, "name"),
      install: {
        required: Boolean(install.required),
        checkCommand: requireString(p, install as Record<string, unknown>, "checkCommand"),
        installCommand: typeof install.installCommand === "string" ? install.installCommand : undefined,
      },
      verify: requireString(p, r, "verify"),
      usage: typeof r.usage === "string" ? r.usage : "",
      allowedUses: Array.isArray(r.allowedUses) ? (r.allowedUses as string[]) : [],
    })
  }
  return out
}

function parseScripts(p: string, raw: unknown): Profile["scripts"] {
  if (!raw || typeof raw !== "object") {
    throw new ProfileError(p, `"scripts" must be an object with preflight and postflight arrays`)
  }
  const r = raw as Record<string, unknown>
  return {
    preflight: parseScriptList(p, "preflight", r.preflight),
    postflight: parseScriptList(p, "postflight", r.postflight),
  }
}

function parseInputArtifacts(p: string, raw: unknown): InputArtifactSpec[] {
  if (raw === undefined || raw === null) return []
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProfileError(p, `"input" must be an object with an "artifacts" array`)
  }
  const list = (raw as Record<string, unknown>).artifacts
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw new ProfileError(p, `"input.artifacts" must be an array`)
  const out: InputArtifactSpec[] = []
  for (const [i, item] of list.entries()) {
    if (typeof item === "string") {
      out.push({ name: item })
      continue
    }
    if (!item || typeof item !== "object") {
      throw new ProfileError(p, `input.artifacts[${i}] must be a string or object`)
    }
    const r = item as Record<string, unknown>
    const name = requireString(p, r, "name")
    const spec: InputArtifactSpec = { name }
    if (typeof r.required === "boolean") spec.required = r.required
    out.push(spec)
  }
  return out
}

function parseOutputArtifacts(p: string, raw: unknown): OutputArtifactSpec[] {
  if (raw === undefined || raw === null) return []
  if (typeof raw !== "object" || Array.isArray(raw)) return []
  const list = (raw as Record<string, unknown>).artifacts
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw new ProfileError(p, `"output.artifacts" must be an array`)
  const out: OutputArtifactSpec[] = []
  for (const [i, item] of list.entries()) {
    if (!item || typeof item !== "object") {
      throw new ProfileError(p, `output.artifacts[${i}] must be an object`)
    }
    const r = item as Record<string, unknown>
    out.push({
      name: requireString(p, r, "name"),
      format: typeof r.format === "string" ? r.format : "text",
      from: requireString(p, r, "from"),
    })
  }
  return out
}

/**
 * Parse + validate a container's `children` array. Enforces the invariant
 * that role==="container" iff children is a non-empty array.
 */
function parseContainerChildren(p: string, role: Profile["role"], raw: unknown): ContainerChild[] | undefined {
  const isContainer = role === "container"
  const present = raw !== undefined && raw !== null

  if (!isContainer) {
    if (!present) return undefined
    if (Array.isArray(raw) && raw.length === 0) return undefined
    throw new ProfileError(p, `"children" is only allowed when role === "container"`)
  }

  if (!present) {
    throw new ProfileError(p, `role: "container" requires a non-empty "children" array`)
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ProfileError(p, `role: "container" requires a non-empty "children" array`)
  }

  const out: ContainerChild[] = []
  for (const [i, item] of (raw as unknown[]).entries()) {
    if (!item || typeof item !== "object") {
      throw new ProfileError(p, `children[${i}] must be an object { exec, target, next }`)
    }
    const r = item as Record<string, unknown>
    const exec = requireString(p, r, "exec")
    const target = requireString(p, r, "target")
    if (!VALID_CONTAINER_CHILD_TARGETS.has(target)) {
      throw new ProfileError(p, `children[${i}].target must be "issue" or "pr"`)
    }
    if (!r.next || typeof r.next !== "object" || Array.isArray(r.next)) {
      throw new ProfileError(p, `children[${i}].next must be an object mapping action types to next step`)
    }
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.next as Record<string, unknown>)) {
      if (typeof v !== "string" || v.length === 0) {
        throw new ProfileError(p, `children[${i}].next["${k}"] must be a non-empty string`)
      }
      next[k] = v
    }
    out.push({ exec, target: target as ContainerChild["target"], next })
  }
  return out
}

function parseScriptList(p: string, key: string, raw: unknown): ScriptEntry[] {
  if (!Array.isArray(raw)) {
    throw new ProfileError(p, `scripts.${key} must be an array`)
  }
  const out: ScriptEntry[] = []
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") {
      throw new ProfileError(
        p,
        `scripts.${key}[${i}] must be an object like { script, runWhen? } or { shell, runWhen? }`,
      )
    }
    const r = item as Record<string, unknown>
    const hasScript = typeof r.script === "string" && (r.script as string).length > 0
    const hasShell = typeof r.shell === "string" && (r.shell as string).length > 0
    if (hasScript && hasShell) {
      throw new ProfileError(p, `scripts.${key}[${i}] cannot set both "script" and "shell" — pick one`)
    }
    if (!hasScript && !hasShell) {
      throw new ProfileError(
        p,
        `scripts.${key}[${i}] must set "script" (registered TS function) or "shell" (filename in agentAction dir)`,
      )
    }
    const entry: ScriptEntry = {}
    if (hasScript) entry.script = r.script as string
    if (hasShell) entry.shell = r.shell as string
    if (r.runWhen && typeof r.runWhen === "object") {
      entry.runWhen = r.runWhen as ScriptEntry["runWhen"]
    }
    if (r.with && typeof r.with === "object") {
      entry.with = r.with as ScriptEntry["with"]
    }
    if (typeof r.timeoutSec === "number" && r.timeoutSec > 0) {
      if (!hasShell) {
        throw new ProfileError(p, `scripts.${key}[${i}] "timeoutSec" only applies to shell entries`)
      }
      entry.timeoutSec = r.timeoutSec
    }
    out.push(entry)
  }
  return out
}
