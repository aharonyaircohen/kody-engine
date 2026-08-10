/**
 * Profile loader + validator.
 *
 * Reads an implementation profile.json from disk, applies permissive defaults,
 * and checks invariants (every referenced script exists in the registry,
 * every input spec is well-formed, etc.). The executor treats a loaded
 * Profile as trustworthy.
 */

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { CAPABILITY_MCP_TOOL_NAMES } from "./capabilityMcp.js"
import { parseReasoningEffort } from "./config.js"
import type {
  AuthSpec,
  ClaudeCodeSpec,
  CliToolSpec,
  ContainerChild,
  InputArtifactSpec,
  InputSpec,
  OutputArtifactSpec,
  Profile,
  ScriptEntry,
} from "./implementations/types.js"
import { applyLifecycle } from "./lifecycles/index.js"
import { ProfileError } from "./profile-error.js"
import { resolveImplementation } from "./registry.js"
import { captureSubagentTemplates } from "./subagents.js"

export { ProfileError } from "./profile-error.js"

const VALID_INPUT_TYPES = new Set(["int", "string", "bool", "enum"])
const VALID_PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions"])
const VALID_ROLES = new Set(["primitive", "orchestrator", "container", "watch", "utility"])
const VALID_CONTAINER_CHILD_TARGETS = new Set(["issue", "pr"])
const VALID_PHASES = new Set(["research", "planning", "implementing", "reviewing", "shipped", "failed", "idle"])

/**
 * Top-level profile keys that the loader understands. Unknown keys are
 * warned about on load so typos like `clude_code` or `mcpServer` surface
 * immediately instead of being silently dropped. Warnings are non-fatal
 * — operators can still ship a profile with experimental fields.
 */
const KNOWN_PROFILE_KEYS = new Set([
  "canonicalContract",
  "name",
  "action",
  "implementation",
  "implementations",
  "internal",
  "public",
  "capabilityKind",
  "slug",
  "title",
  "skills",
  "prompt",
  "chatTools",
  "auth",
  "agent",
  "every",
  "capabilityTools",
  "capabilityTools",
  "tools",
  "capabilityToolMode",
  "mentions",
  "stage",
  "readsFrom",
  "writesTo",
  "workflow",
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

  const document = raw as Record<string, unknown>
  const r = compileRuntimeDocument(profilePath, document)

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

  // Capability-as-reference: an capability stores a capability
  // contract and names the implementation instead of embedding it.
  // Resolve that implementation's full profile and overlay this contract's identity
  // (name) + agent (who) + mentions. The capability folder then stays a
  // thin binding — no claudeCode/prompt/scripts of its own.
  // Intent = why, agent = who, capability = how, implementation = implementation.
  const execRef = typeof r.implementation === "string" && r.implementation.trim() ? r.implementation.trim() : ""
  if (execRef) {
    const refPath = resolveImplementation(execRef)
    if (!refPath) {
      throw new ProfileError(profilePath, `capability references unknown implementation '${execRef}'`)
    }
    if (path.resolve(refPath) === path.resolve(profilePath)) {
      // A capability folder can be both the public contract and the runnable
      // implementation profile. In that case, keep parsing this file instead
      // of recursively loading itself as a contract overlay.
    } else {
      const base = loadProfile(refPath)
      return {
        ...base,
        name: requireString(profilePath, r, "name"),
        action: typeof r.action === "string" && r.action.trim() ? r.action.trim() : undefined,
        implementation: execRef,
        internal: typeof r.internal === "boolean" ? r.internal : base.internal,
        public: typeof r.public === "boolean" ? r.public : base.public,
        capabilityKind: parseCapabilityKind(r.capabilityKind) ?? base.capabilityKind,
        slug: typeof r.slug === "string" && r.slug.trim() ? r.slug.trim() : base.slug,
        title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : base.title,
        skills: parseStringArray(r.skills) ?? base.skills,
        prompt: typeof r.prompt === "string" && r.prompt.trim() ? r.prompt.trim() : base.prompt,
        chatTools: parseStringArray(r.chatTools) ?? base.chatTools,
        describe: typeof r.describe === "string" ? r.describe : base.describe,
        agent: typeof r.agent === "string" && r.agent.trim() ? r.agent.trim() : base.agent,
        capabilityTools: parseStringArray(r.capabilityTools ?? r.capabilityTools ?? r.tools) ?? base.capabilityTools,
        capabilityToolMode: parseCapabilityToolMode(profilePath, r.capabilityToolMode) ?? base.capabilityToolMode,
        mentions: Array.isArray(r.mentions)
          ? (r.mentions as string[]).map((m) => String(m).trim()).filter(Boolean)
          : base.mentions,
      }
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
    implementation: undefined,
    internal: typeof r.internal === "boolean" ? r.internal : undefined,
    public: typeof r.public === "boolean" ? r.public : undefined,
    capabilityKind: parseCapabilityKind(r.capabilityKind),
    slug: typeof r.slug === "string" && r.slug.trim() ? r.slug.trim() : undefined,
    title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : undefined,
    skills: parseStringArray(r.skills),
    prompt: typeof r.prompt === "string" && r.prompt.trim() ? r.prompt.trim() : undefined,
    chatTools: parseStringArray(r.chatTools),
    auth: parseAuth(profilePath, r.auth),
    describe: typeof r.describe === "string" ? r.describe : "",
    // Optional agent to run as. Empty/blank string → undefined (no agent).
    agent: typeof r.agent === "string" && r.agent.trim() ? r.agent.trim() : undefined,
    // Locked-toolbox palette + mentions from folder-capability profile metadata.
    capabilityTools: parseStringArray(r.capabilityTools ?? r.capabilityTools ?? r.tools),
    capabilityToolMode: parseCapabilityToolMode(profilePath, r.capabilityToolMode),
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
  // a capabilityTools typo should be caught here, not at the capability's first run.
  if (profile.capabilityTools && profile.capabilityTools.length > 0) {
    const palette = new Set<string>(CAPABILITY_MCP_TOOL_NAMES)
    const unknown = profile.capabilityTools.filter((t) => !palette.has(t))
    if (unknown.length > 0) {
      throw new ProfileError(
        profilePath,
        `capabilityTools not in the kody-capability palette: ${unknown.join(", ")}. Available: ${[...CAPABILITY_MCP_TOOL_NAMES].join(", ")}`,
      )
    }
  }

  // State-script pairing: writeJobStateFile/parseJobStateFromAgentResult read
  // ctx.data.jobState, which only a state loader (loadCapabilityState or
  // loadJobFromFile) sets. Declaring the save half without the load half throws
  // at run time — catch the misconfig at load instead.
  const preNames = new Set(profile.scripts.preflight.map((e) => e.script).filter(Boolean))
  const postNames = profile.scripts.postflight.map((e) => e.script).filter(Boolean)
  const needsState = postNames.includes("writeJobStateFile") || postNames.includes("parseJobStateFromAgentResult")
  // Any of these preflights populate ctx.data.jobState: loadCapabilityState (folder
  // capability), loadJobFromFile (markdown capability via capability-tick), runTickScript (scripted
  // capability via capability-tick-scripted).
  const STATE_LOADERS = [
    "loadCapabilityState",
    "loadJobFromFile",
    "runTickScript",
    "runScheduledImplementationTick",
    "runScheduledExecutableTick",
  ]
  if (needsState && !STATE_LOADERS.some((s) => preNames.has(s))) {
    throw new ProfileError(
      profilePath,
      `postflight uses writeJobStateFile/parseJobStateFromAgentResult but no state loader (${STATE_LOADERS.join(" | ")}) is declared in preflight`,
    )
  }

  // Snapshot declared subagents now, on the default checkout, so they survive a
  // later task-branch switch that may drop the capability's agents/ dir.
  profile.subagentTemplates = captureSubagentTemplates(profile)

  return profile
}

function compileRuntimeDocument(runtimePath: string, document: Record<string, unknown>): Record<string, unknown> {
  if (path.basename(runtimePath) !== "runtime.json") return document
  if (document.adapter !== "kody-engine-profile") {
    throw new ProfileError(runtimePath, "unsupported runtime adapter document")
  }
  const implementationDir = path.dirname(runtimePath)
  const implementation = readJsonObject(path.join(implementationDir, "definition.json"), "Implementation definition")
  const definitionsRoot = path.dirname(path.dirname(implementationDir))
  const capabilityId =
    implementation.capabilityRef &&
    typeof implementation.capabilityRef === "object" &&
    !Array.isArray(implementation.capabilityRef)
      ? (implementation.capabilityRef as Record<string, unknown>).id
      : undefined
  if (typeof capabilityId !== "string" || !capabilityId) {
    throw new ProfileError(runtimePath, "Implementation capabilityRef is invalid")
  }
  const capability = readJsonObject(
    path.join(definitionsRoot, "capabilities", capabilityId, "definition.json"),
    "Capability definition",
  )
  const {
    adapter: _adapter,
    inputBindings: _inputBindings,
    outputBindings: _outputBindings,
    requirements: _requirements,
    config: nestedConfig,
    ...inlineConfig
  } = document
  const config =
    nestedConfig && typeof nestedConfig === "object" && !Array.isArray(nestedConfig)
      ? (nestedConfig as Record<string, unknown>)
      : inlineConfig
  const agentRef =
    implementation.agentRef && typeof implementation.agentRef === "object" && !Array.isArray(implementation.agentRef)
      ? (implementation.agentRef as Record<string, unknown>).id
      : undefined
  return {
    ...config,
    name: implementation.id,
    action: capability.action,
    describe: capability.purpose,
    inputs: config.inputs ?? [],
    agent: agentRef,
    canonicalContract: {
      capabilityId,
      capabilityRevision: createHash("sha256").update(canonical(capability)).digest("hex"),
      implementationId: String(implementation.id),
      implementationRevision: createHash("sha256").update(canonical(implementation)).digest("hex"),
      inputSchema: capability.inputSchema,
      outputSchema: capability.outputSchema,
    },
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function readJsonObject(filePath: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf-8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("must be an object")
    }
    return value as Record<string, unknown>
  } catch (error) {
    throw new ProfileError(filePath, `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseCapabilityToolMode(profilePath: string, raw: unknown): Profile["capabilityToolMode"] {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (raw === "lock" || raw === "append") return raw
  throw new ProfileError(profilePath, `"capabilityToolMode" must be "lock" or "append"`)
}

/**
 * Capture a profile's prompt template files at load time — `prompt.md`,
 * folder-capability `capability.md`, and any `prompts/*.md` — keyed by absolute path.
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
  read(path.join(dir, "capability.md"))
  read(path.join(dir, "capability.md"))
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

function parseStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const values = raw.map((t) => String(t).trim()).filter(Boolean)
  return values.length > 0 ? values : undefined
}

const AUTH_KEY_RE = /^[A-Z][A-Z0-9_]{0,127}$/
const AUTH_TEXT_RE = /^[^\r\n]{1,120}$/

function rejectUnknownAuthFields(
  p: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
): void {
  const known = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !known.has(key))
  if (unknown) throw new ProfileError(p, `${prefix} has unknown field "${unknown}"`)
}

function parseAuth(p: string, raw: unknown): AuthSpec | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProfileError(p, `"auth" must be an object`)
  }

  const auth = raw as Record<string, unknown>
  rejectUnknownAuthFields(p, auth, ["methods"], "auth")
  const methodsRaw = auth.methods
  if (!Array.isArray(methodsRaw) || methodsRaw.length === 0) {
    throw new ProfileError(p, `auth.methods must be a non-empty array`)
  }

  const methods: AuthSpec["methods"] = methodsRaw.map((methodRaw, methodIndex) => {
    if (!methodRaw || typeof methodRaw !== "object" || Array.isArray(methodRaw)) {
      throw new ProfileError(p, `auth.methods[${methodIndex}] must be an object`)
    }
    const method = methodRaw as Record<string, unknown>
    rejectUnknownAuthFields(p, method, ["name", "strategy", "adapter", "fields"], `auth.methods[${methodIndex}]`)
    const name = method.name
    if (typeof name !== "string" || !AUTH_TEXT_RE.test(name.trim())) {
      throw new ProfileError(p, `auth.methods[${methodIndex}].name must be a single-line string of 1-120 characters`)
    }
    if (method.strategy !== "browser-storage-state") {
      throw new ProfileError(p, `auth.methods[${methodIndex}].strategy must be browser-storage-state`)
    }
    if (method.adapter !== "kody-repository") {
      throw new ProfileError(p, `auth.methods[${methodIndex}].adapter must be kody-repository`)
    }
    if (!Array.isArray(method.fields) || method.fields.length === 0) {
      throw new ProfileError(p, `auth.methods[${methodIndex}].fields must be a non-empty array`)
    }

    const fields: AuthSpec["methods"][number]["fields"] = method.fields.map((fieldRaw, fieldIndex) => {
      const prefix = `auth.methods[${methodIndex}].fields[${fieldIndex}]`
      if (!fieldRaw || typeof fieldRaw !== "object" || Array.isArray(fieldRaw)) {
        throw new ProfileError(p, `${prefix} must be an object`)
      }
      const field = fieldRaw as Record<string, unknown>
      rejectUnknownAuthFields(p, field, ["label", "source", "key"], prefix)
      if (typeof field.label !== "string" || !AUTH_TEXT_RE.test(field.label.trim())) {
        throw new ProfileError(p, `${prefix}.label must be a single-line string of 1-120 characters`)
      }
      if (field.source !== "variable" && field.source !== "secret") {
        throw new ProfileError(p, `${prefix}.source must be variable or secret`)
      }
      if (typeof field.key !== "string" || !AUTH_KEY_RE.test(field.key)) {
        throw new ProfileError(p, `${prefix}.key must be an uppercase variable or secret name`)
      }
      return {
        label: field.label.trim(),
        source: field.source,
        key: field.key,
      }
    })

    const variableFields = fields.filter((field) => field.source === "variable")
    const secretFields = fields.filter((field) => field.source === "secret")
    if (variableFields.length !== 1 || secretFields.length !== 1) {
      throw new ProfileError(
        p,
        `auth.methods[${methodIndex}] kody-repository requires exactly one variable field and one secret field`,
      )
    }

    return {
      name: name.trim(),
      strategy: method.strategy,
      adapter: method.adapter,
      fields,
    }
  })

  return { methods }
}

function parseCapabilityKind(raw: unknown): Profile["capabilityKind"] | undefined {
  return raw === "observe" || raw === "act" || raw === "verify" ? raw : undefined
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
  const disallowedTools = Array.isArray(r.disallowedTools) ? (r.disallowedTools as string[]) : []
  // An empty tools array is permitted for configless / agentless implementations
  // (e.g. `init`, `release`). Such implementations must set ctx.skipAgent in a
  // preflight script — the executor refuses to invoke the agent without tools
  // and without skipAgent, surfacing the misconfiguration loudly.

  return {
    model: typeof r.model === "string" ? r.model : "inherit",
    permissionMode,
    maxTurns: typeof r.maxTurns === "number" ? r.maxTurns : null,
    disallowedTools,
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
      throw new ProfileError(p, `children[${i}] must be an object { implementation, target, next }`)
    }
    const r = item as Record<string, unknown>
    const implementation = requireString(p, r, "implementation")
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
    out.push({ implementation, target: target as ContainerChild["target"], next })
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
        `scripts.${key}[${i}] must set "script" (registered TS function) or "shell" (filename in implementation dir)`,
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
