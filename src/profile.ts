/**
 * Profile loader + validator.
 *
 * Reads an executable profile.json from disk, applies permissive defaults,
 * and checks invariants (every referenced script exists in the registry,
 * every input spec is well-formed, etc.). The executor treats a loaded
 * Profile as trustworthy.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type {
  ClaudeCodeSpec,
  CliToolSpec,
  InputArtifactSpec,
  InputSpec,
  OutputArtifactSpec,
  Profile,
  ScriptEntry,
} from "./executables/types.js"

const VALID_INPUT_TYPES = new Set(["int", "string", "bool", "enum"])
const VALID_PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions"])
const VALID_ROLES = new Set(["primitive", "orchestrator", "watch", "utility"])
const VALID_PHASES = new Set(["research", "planning", "implementing", "reviewing", "shipped", "failed", "idle"])

export class ProfileError extends Error {
  constructor(
    public profilePath: string,
    message: string,
  ) {
    super(`Invalid profile at ${profilePath}:\n  ${message}`)
    this.name = "ProfileError"
  }
}

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

  const kind = r.kind === "scheduled" ? "scheduled" : "oneshot"
  if (kind === "scheduled" && typeof r.schedule !== "string") {
    throw new ProfileError(profilePath, `kind: "scheduled" requires a "schedule" cron string`)
  }

  if (typeof r.role !== "string" || !VALID_ROLES.has(r.role)) {
    throw new ProfileError(
      profilePath,
      `"role" is required and must be one of: ${[...VALID_ROLES].join(" | ")}`,
    )
  }
  const role = r.role as Profile["role"]

  let phase: Profile["phase"]
  if (r.phase !== undefined) {
    if (typeof r.phase !== "string" || !VALID_PHASES.has(r.phase)) {
      throw new ProfileError(profilePath, `"phase" must be one of: ${[...VALID_PHASES].join(" | ")}`)
    }
    phase = r.phase as Profile["phase"]
  }

  const profile: Profile = {
    name: requireString(profilePath, r, "name"),
    describe: typeof r.describe === "string" ? r.describe : "",
    role,
    kind,
    schedule: typeof r.schedule === "string" ? r.schedule : undefined,
    phase,
    inputs: parseInputs(profilePath, r.inputs),
    claudeCode: parseClaudeCode(profilePath, r.claudeCode),
    cliTools: parseCliTools(profilePath, r.cliTools),
    scripts: parseScripts(profilePath, r.scripts),
    outputContract: r.outputContract as Profile["outputContract"],
    inputArtifacts: parseInputArtifacts(profilePath, r.input),
    outputArtifacts: parseOutputArtifacts(profilePath, r.output),
    dir: path.dirname(profilePath),
  }

  return profile
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
  // An empty tools array is permitted for configless / agentless executables
  // (e.g. `init`, `release`). Such executables must set ctx.skipAgent in a
  // preflight script — the executor refuses to invoke the agent without tools
  // and without skipAgent, surfacing the misconfiguration loudly.

  return {
    model: typeof r.model === "string" ? r.model : "inherit",
    permissionMode,
    maxTurns: typeof r.maxTurns === "number" ? r.maxTurns : null,
    maxThinkingTokens: typeof r.maxThinkingTokens === "number" ? r.maxThinkingTokens : null,
    systemPromptAppend: typeof r.systemPromptAppend === "string" ? r.systemPromptAppend : null,
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

function parseScriptList(p: string, key: string, raw: unknown): ScriptEntry[] {
  if (!Array.isArray(raw)) {
    throw new ProfileError(p, `scripts.${key} must be an array`)
  }
  const out: ScriptEntry[] = []
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") {
      throw new ProfileError(p, `scripts.${key}[${i}] must be an object like { script, runWhen? } or { shell, runWhen? }`)
    }
    const r = item as Record<string, unknown>
    const hasScript = typeof r.script === "string" && (r.script as string).length > 0
    const hasShell = typeof r.shell === "string" && (r.shell as string).length > 0
    if (hasScript && hasShell) {
      throw new ProfileError(p, `scripts.${key}[${i}] cannot set both "script" and "shell" — pick one`)
    }
    if (!hasScript && !hasShell) {
      throw new ProfileError(p, `scripts.${key}[${i}] must set "script" (registered TS function) or "shell" (filename in executable dir)`)
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
    out.push(entry)
  }
  return out
}
