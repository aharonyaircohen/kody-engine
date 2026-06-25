/**
 * Engine asset auto-discovery.
 *
 * Two asset families live alongside each other:
 *
 * - **AgentActions** (`.kody/agent-actions/<name>/profile.json` in the hydrated local cache/store,
 *   plus minimal engine built-ins) implementation units selected by agentResponsibilities.
 *   - **AgentResponsibilities** (`.kody/agent-responsibilities/<slug>/profile.json` + `agent-responsibility.md`) — public
 *     work units and operator-facing actions. AgentResponsibility discovery is handled by
 *     `listAgentResponsibilityActions()`, not by agentAction resolution.
 *
 * Both follow the same dev/built path-resolution pattern so `src/` and
 * `dist/` layouts work identically.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { CapabilityKind, InputSpec } from "./agent-actions/types.js"
import type { AgentResponsibilityFolder } from "./agent-responsibilityFolders.js"
import {
  AGENT_RESPONSIBILITY_PROFILE_FILE,
  listAgentResponsibilityFolderSlugs,
  readAgentResponsibilityFolder,
} from "./agent-responsibilityFolders.js"
import { getCompanyStoreAssetRoot } from "./companyStore.js"

const PUBLIC_AGENT_ACTION_ACTION_ROLES = new Set(["primitive", "orchestrator", "container", "watch", "utility"])
const PUBLIC_AGENT_ACTION_CAPABILITY_KINDS = new Set(["observe", "act", "verify"])

export interface DiscoveredAgentAction {
  name: string
  profilePath: string
}

export interface DiscoveredAgentResponsibilityAction {
  /** Public action typed by a user, e.g. `@kody run`. */
  action: string
  /** AgentResponsibility slug that owns the public action. */
  agentResponsibility: string
  /** Implementation agentAction selected by the agentResponsibility. */
  agentAction: string
  /** Extra args required to lower the agentResponsibility to its implementation. */
  cliArgs: Record<string, unknown>
  source: "project-folder" | "project-agentAction" | "company-store" | "company-store-agentAction" | "builtin"
  describe?: string
  capabilityKind?: CapabilityKind
  profilePath?: string
  bodyPath?: string
}

/**
 * Resolve the engine's built-in agentActions root. Mirrors `resolveProfilePath`
 * in executor.ts so dev (src/) and built (dist/) layouts both work.
 */
export function getAgentActionsRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const candidates = [
    path.join(here, "agent-actions"), // dev: src/
    path.join(here, "..", "agent-actions"), // built: dist/bin → dist/agent-actions
    path.join(here, "..", "src", "agent-actions"), // fallback
  ]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c
  }
  return candidates[0]!
}

/**
 * Resolve the hydrated local agentActions root. Looks for `.kody/agent-actions/`
 * relative to the current working directory after state-repo hydration.
 * Returns the path even if it doesn't exist;
 * callers must check.
 */
export function getProjectAgentActionsRoot(): string {
  return path.join(process.cwd(), ".kody", "agent-actions")
}

/**
 * Resolve the hydrated local agentResponsibilities root (`.kody/agent-responsibilities/`). A agentResponsibility is a public
 * work unit: it owns action/purpose and selects an implementation agentAction.
 * Returns the path even if it doesn't exist; callers must check.
 */
export function getProjectAgentResponsibilitiesRoot(): string {
  return path.join(process.cwd(), ".kody", "agent-responsibilities")
}

export function getCompanyStoreAgentActionsRoot(): string | null {
  return getCompanyStoreAssetRoot("agentActions")
}

export function getCompanyStoreAgentResponsibilitiesRoot(): string | null {
  return getCompanyStoreAssetRoot("agentResponsibilities")
}

export function getBuiltinAgentResponsibilitiesRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const candidates = [
    path.join(here, "agent-responsibilities"), // dev: src/
    path.join(here, "..", "agent-responsibilities"), // built: dist/bin → dist/agent-responsibilities
    path.join(here, "..", "src", "agent-responsibilities"), // fallback
  ]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c
  }
  return candidates[0]!
}

/**
 * Ordered list of agentAction roots, project first, engine second. Project
 * roots override engine roots on name conflict — hydrated state-repo assets
 * win. Engine ships a stdlib; projects can override or add private
 * implementation units under state-repo `agent-actions/<name>/`.
 */
export function getAgentActionRoots(): string[] {
  const storeRoot = getCompanyStoreAgentActionsRoot()
  return [getProjectAgentActionsRoot(), ...(storeRoot ? [storeRoot] : []), getAgentActionsRoot()]
}

export function getAgentResponsibilityRoots(
  projectAgentResponsibilitiesRoot: string = getProjectAgentResponsibilitiesRoot(),
): string[] {
  const storeRoot = getCompanyStoreAgentResponsibilitiesRoot()
  return [projectAgentResponsibilitiesRoot, ...(storeRoot ? [storeRoot] : []), getBuiltinAgentResponsibilitiesRoot()]
}

/**
 * Names of the engine-bundled agentActions (the dir names under the engine root
 * that contain a profile.json). Cached — the engine root never changes within a
 * process. Used to stop a hydrated `.kody/agent-responsibilities/<name>/` folder from silently
 * shadowing an engine builtin (run/merge/serve/agent-responsibility-scheduler/…).
 */
let _builtinNames: Set<string> | null = null
export function builtinAgentActionNames(): Set<string> {
  if (_builtinNames) return _builtinNames
  const out = new Set<string>()
  const root = getAgentActionsRoot()
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (ent.isDirectory() && fs.existsSync(path.join(root, ent.name, "profile.json"))) out.add(ent.name)
    }
  } catch {
    /* engine root unreadable — leave empty (no shadow protection, fail-open) */
  }
  _builtinNames = out
  return out
}

/** True iff `name` is an engine-bundled agentAction that agentResponsibilities must not shadow. */
export function isBuiltinAgentAction(name: string): boolean {
  return builtinAgentActionNames().has(name)
}

/**
 * List every discovered agentAction across agentAction roots. On name conflict
 * the first root wins, so hydrated state-repo `agent-actions/chat/`
 * shadows the engine's `chat`. Each needs a directory containing a readable
 * `profile.json`. Directories without one are silently skipped.
 */
export function listAgentActions(roots: string | string[] = getAgentActionRoots()): DiscoveredAgentAction[] {
  const rootList = typeof roots === "string" ? [roots] : roots
  const seen = new Set<string>()
  const out: DiscoveredAgentAction[] = []
  for (const root of rootList) {
    if (!fs.existsSync(root)) continue
    const entries = fs.readdirSync(root, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      if (seen.has(ent.name)) continue // earlier root wins
      const profilePath = path.join(root, ent.name, AGENT_RESPONSIBILITY_PROFILE_FILE)
      if (fs.existsSync(profilePath) && fs.statSync(profilePath).isFile()) {
        out.push({ name: ent.name, profilePath })
        seen.add(ent.name)
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve a single agentAction by name across all roots. Returns the first
 * matching `profile.json` path, or null if nothing matches.
 */
export function resolveAgentAction(name: string, roots: string | string[] = getAgentActionRoots()): string | null {
  if (!isSafeName(name)) return null
  const rootList = typeof roots === "string" ? [roots] : roots
  for (const root of rootList) {
    const profilePath = path.join(root, name, "profile.json")
    if (fs.existsSync(profilePath) && fs.statSync(profilePath).isFile()) {
      return profilePath
    }
  }
  return null
}

/** Convenience: true iff `<name>/profile.json` exists in any root. */
export function hasAgentAction(name: string, roots: string | string[] = getAgentActionRoots()): boolean {
  return resolveAgentAction(name, roots) !== null
}

/**
 * List public agentResponsibility actions. AgentResponsibilities own the operator-facing action name; an
 * agentAction is only the selected implementation. Ordering is intentional:
 * project folder agentResponsibilities override company store agentResponsibilities, which override
 * engine built-ins.
 */
export function listAgentResponsibilityActions(
  projectAgentResponsibilitiesRoot: string = getProjectAgentResponsibilitiesRoot(),
): DiscoveredAgentResponsibilityAction[] {
  const seen = new Set<string>()
  const out: DiscoveredAgentResponsibilityAction[] = []
  const add = (action: DiscoveredAgentResponsibilityAction) => {
    if (!isSafeName(action.action) || !isSafeName(action.agentResponsibility) || !isSafeName(action.agentAction)) return
    if (seen.has(action.action)) return
    seen.add(action.action)
    out.push(action)
  }

  const roots = getAgentResponsibilityRoots(projectAgentResponsibilitiesRoot)
  const executableRoots = getAgentActionRoots()
  for (const action of listFolderAgentResponsibilityActions(roots[0]!, "project-folder")) add(action)
  for (const action of listAgentActionResponsibilityActions(executableRoots[0]!, "project-agentAction")) add(action)
  if (roots.length === 3) {
    for (const action of listFolderAgentResponsibilityActions(roots[1]!, "company-store")) add(action)
    for (const action of listAgentActionResponsibilityActions(executableRoots[1]!, "company-store-agentAction"))
      add(action)
    for (const action of listBuiltinAgentResponsibilityActions(roots[2]!)) add(action)
  } else {
    for (const action of listBuiltinAgentResponsibilityActions(roots[1]!)) add(action)
  }
  return out.sort((a, b) => a.action.localeCompare(b.action))
}

/** Resolve one public action to the agentResponsibility that owns it. */
export function resolveAgentResponsibilityAction(
  action: string,
  projectAgentResponsibilitiesRoot: string = getProjectAgentResponsibilitiesRoot(),
): DiscoveredAgentResponsibilityAction | null {
  if (!isSafeName(action)) return null
  return listAgentResponsibilityActions(projectAgentResponsibilitiesRoot).find((d) => d.action === action) ?? null
}

export function hasAgentResponsibilityAction(
  action: string,
  projectAgentResponsibilitiesRoot: string = getProjectAgentResponsibilitiesRoot(),
): boolean {
  return resolveAgentResponsibilityAction(action, projectAgentResponsibilitiesRoot) !== null
}

export function resolveAgentResponsibilityFolder(
  slug: string,
  projectAgentResponsibilitiesRoot: string = getProjectAgentResponsibilitiesRoot(),
): AgentResponsibilityFolder | null {
  if (!isSafeName(slug)) return null
  for (const root of getAgentResponsibilityRoots(projectAgentResponsibilitiesRoot)) {
    const agentResponsibility = readAgentResponsibilityFolder(root, slug)
    if (agentResponsibility) return agentResponsibility
  }
  return null
}

/** Read the implementation profile inputs for a public agentResponsibility action. */
export function getAgentResponsibilityActionInputs(action: string): InputSpec[] | null {
  const resolved = resolveAgentResponsibilityAction(action)
  if (!resolved) return null
  return getProfileInputs(resolved.agentAction)
}

export function resolveAgentResponsibilityExecution(agentResponsibility: AgentResponsibilityFolder): {
  agentAction: string
  cliArgs: Record<string, unknown>
} {
  const agentAction =
    agentResponsibility.config.agentAction ??
    agentResponsibility.config.agentActions?.[0] ??
    (agentResponsibility.config.tickScript ? "agent-responsibility-tick-scripted" : "agent-responsibility-tick")
  const cliArgs = agentActionDeclaresInput(agentAction, "agentResponsibility")
    ? { agentResponsibility: agentResponsibility.slug }
    : {}
  return { agentAction, cliArgs }
}

function agentActionDeclaresInput(agentAction: string, inputName: string): boolean {
  const profilePath = resolveAgentAction(agentAction)
  if (!profilePath) return false
  try {
    const raw = JSON.parse(fs.readFileSync(profilePath, "utf-8")) as { inputs?: unknown }
    if (!Array.isArray(raw.inputs)) return false
    return raw.inputs.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
      const input = entry as { name?: unknown; flag?: unknown }
      return input.name === inputName || input.flag === `--${inputName}`
    })
  } catch {
    return false
  }
}

/** AgentAction names: lowercase letters, digits, and dashes. Rejects traversal. */
export function isSafeName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name) && !name.includes("..")
}

function listAgentActionResponsibilityActions(
  root: string,
  source: "project-agentAction" | "company-store-agentAction",
): DiscoveredAgentResponsibilityAction[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: DiscoveredAgentResponsibilityAction[] = []
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || !isSafeName(ent.name)) continue
    const profilePath = path.join(root, ent.name, AGENT_RESPONSIBILITY_PROFILE_FILE)
    if (!fs.existsSync(profilePath) || !fs.statSync(profilePath).isFile()) continue
    try {
      const raw = JSON.parse(fs.readFileSync(profilePath, "utf-8")) as Record<string, unknown>
      const action = typeof raw.action === "string" && raw.action.trim() ? raw.action.trim() : ""
      if (!action) continue
      if (!PUBLIC_AGENT_ACTION_ACTION_ROLES.has(String(raw.role))) continue
      if (!PUBLIC_AGENT_ACTION_CAPABILITY_KINDS.has(String(raw.capabilityKind))) continue
      if (!Array.isArray(raw.inputs)) continue
      out.push({
        action,
        agentResponsibility: ent.name,
        agentAction: ent.name,
        cliArgs: {},
        source,
        describe: typeof raw.describe === "string" ? raw.describe : undefined,
        profilePath,
      })
    } catch {}
  }
  return out.sort((a, b) => a.action.localeCompare(b.action))
}

function listFolderAgentResponsibilityActions(
  root: string,
  source: "project-folder" | "company-store",
): DiscoveredAgentResponsibilityAction[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: DiscoveredAgentResponsibilityAction[] = []
  for (const slug of listAgentResponsibilityFolderSlugs(root)) {
    if (!isSafeName(slug)) continue
    const agentResponsibility = readAgentResponsibilityFolder(root, slug)
    if (!agentResponsibility) continue
    const action = agentResponsibility.config.action ?? slug
    const { agentAction, cliArgs } = resolveAgentResponsibilityExecution(agentResponsibility)
    out.push({
      action,
      agentResponsibility: slug,
      agentAction,
      cliArgs,
      source,
      describe: agentResponsibility.config.describe ?? agentResponsibility.title,
      capabilityKind: agentResponsibility.config.capabilityKind,
      profilePath: agentResponsibility.profilePath,
      bodyPath: agentResponsibility.bodyPath,
    })
  }
  return out.sort((a, b) => a.action.localeCompare(b.action))
}

function listBuiltinAgentResponsibilityActions(
  root: string = getBuiltinAgentResponsibilitiesRoot(),
): DiscoveredAgentResponsibilityAction[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: DiscoveredAgentResponsibilityAction[] = []
  for (const slug of listAgentResponsibilityFolderSlugs(root)) {
    if (!isSafeName(slug)) continue
    const agentResponsibility = readAgentResponsibilityFolder(root, slug)
    if (!agentResponsibility) continue
    const action = agentResponsibility.config.action ?? slug
    const agentAction = agentResponsibility.config.agentAction ?? slug
    out.push({
      action,
      agentResponsibility: slug,
      agentAction,
      cliArgs: {},
      source: "builtin",
      describe: agentResponsibility.config.describe ?? agentResponsibility.title,
      capabilityKind: agentResponsibility.config.capabilityKind,
      profilePath: agentResponsibility.profilePath,
      bodyPath: agentResponsibility.bodyPath,
    })
  }
  return out.sort((a, b) => a.action.localeCompare(b.action))
}

/**
 * Light-weight profile inspector: returns an agentAction's declared `inputs`
 * without running the full profile validator. Dispatch uses this to drive
 * comment-argument parsing entirely from profile metadata. Returns null if
 * the agentAction doesn't exist or the profile is unreadable (dispatch
 * should degrade gracefully, not throw).
 */
export function getProfileInputs(name: string, roots: string | string[] = getAgentActionRoots()): InputSpec[] | null {
  const profilePath = resolveAgentAction(name, roots)
  if (!profilePath) return null
  try {
    const raw = JSON.parse(fs.readFileSync(profilePath, "utf-8"))
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.inputs)) return []
    return raw.inputs as InputSpec[]
  } catch {
    return null
  }
}

/**
 * Minimal generic flag parser for auto-discovered agentActions.
 * Supports `--key value` and `--flag` (boolean). Unknown positionals
 * accumulate in `args._` for the agentAction to reject if it wishes.
 *
 * Dashed flags get both shapes in the output: `--run-id 42` produces
 * `{ "run-id": "42", runId: "42" }` so profiles can name inputs with
 * either convention. The executor's `validateInputs` is the authoritative
 * validator — this is only responsible for turning argv into a bag.
 */
export function parseGenericFlags(argv: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    let value: unknown = true
    if (next !== undefined && !next.startsWith("--")) {
      value = next
      i++
    }
    args[key] = value
    if (key.includes("-")) {
      const camel = key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
      if (camel !== key && args[camel] === undefined) args[camel] = value
    }
  }
  if (positional.length > 0) args._ = positional
  return args
}
