/**
 * Engine asset auto-discovery.
 *
 * Capabilities are the project/store model:
 * - public actions are capability folders unless marked internal
 * - implementation profiles also live in capability folders when they declare
 *   an engine role
 *
 * The engine package still has minimal built-in implementation profiles under
 * `src/executables`, but project and company-store `.kody/executables` roots
 * are no longer registry sources.
 *
 * Both follow the same dev/built path-resolution pattern so `src/` and
 * `dist/` layouts work identically.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { CapabilityFolder } from "./capabilityFolders.js"
import { CAPABILITY_PROFILE_FILE, listCapabilityFolderSlugs, readCapabilityFolder } from "./capabilityFolders.js"
import { getCompanyStoreAssetRoot } from "./companyStore.js"
import type { InputSpec } from "./executables/types.js"

const PUBLIC_EXECUTABLE_ROLES = new Set(["primitive", "orchestrator", "container", "watch", "utility"])

export interface DiscoveredExecutable {
  name: string
  profilePath: string
}

export interface DiscoveredCapabilityAction {
  /** Public action typed by a user, e.g. `@kody run`. */
  action: string
  /** Capability slug that owns the public action. */
  capability: string
  /** Implementation executable selected by the capability. */
  executable: string
  /** Extra args required to lower the capability to its implementation. */
  cliArgs: Record<string, unknown>
  source: "project-folder" | "company-store" | "builtin"
  describe?: string
  profilePath?: string
  bodyPath?: string
}

/**
 * Resolve the engine's built-in executables root. Mirrors `resolveProfilePath`
 * in executor.ts so dev (src/) and built (dist/) layouts both work.
 */
export function getExecutablesRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const candidates = [
    path.join(here, "executables"), // dev: src/
    path.join(here, "..", "executables"), // built: dist/bin → dist/executables
    path.join(here, "..", "src", "executables"), // fallback
  ]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c
  }
  return candidates[0]!
}

/**
 * Resolve the canonical hydrated capabilities root. Capabilities are the new
 * public model and may also carry implementation profile data during migration.
 */
export function getProjectCapabilitiesRoot(): string {
  return path.join(process.cwd(), ".kody", "capabilities")
}

export function getCompanyStoreCapabilitiesRoot(): string | null {
  return getCompanyStoreAssetRoot("capabilities")
}

export function getBuiltinCapabilitiesRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const candidates = [
    path.join(here, "capabilities"), // dev: src/
    path.join(here, "..", "capabilities"), // built: dist/bin → dist/capabilities
    path.join(here, "..", "src", "capabilities"), // fallback
  ]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c
  }
  return candidates[0]!
}

/**
 * Ordered list of implementation-profile roots. Capability folders are the
 * external source; the engine-bundled executable root is only the internal
 * stdlib fallback.
 */
export function getExecutableRoots(): string[] {
  const projectCapabilitiesRoot = getProjectCapabilitiesRoot()
  const storeCapabilitiesRoot = getCompanyStoreCapabilitiesRoot()
  return [projectCapabilitiesRoot, ...(storeCapabilitiesRoot ? [storeCapabilitiesRoot] : []), getExecutablesRoot()]
}

export function getCapabilityRoots(projectCapabilitiesRoot: string = getProjectCapabilitiesRoot()): string[] {
  const storeCapabilitiesRoot = getCompanyStoreCapabilitiesRoot()
  return [
    projectCapabilitiesRoot,
    ...(storeCapabilitiesRoot ? [storeCapabilitiesRoot] : []),
    getBuiltinCapabilitiesRoot(),
  ]
}

/**
 * Names of the engine-bundled executables (the dir names under the engine root
 * that contain a profile.json). Cached — the engine root never changes within a
 * process. Used to stop a hydrated `.kody/capabilities/<name>/` folder from silently
 * shadowing an engine builtin (run/merge/serve/capability-scheduler/…).
 */
let _builtinNames: Set<string> | null = null
export function builtinExecutableNames(): Set<string> {
  if (_builtinNames) return _builtinNames
  const out = new Set<string>()
  const root = getExecutablesRoot()
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

/** True iff `name` is an engine-bundled executable that capabilities must not shadow. */
export function isBuiltinExecutable(name: string): boolean {
  return builtinExecutableNames().has(name)
}

/**
 * List every discovered implementation profile. On name conflict the first
 * root wins, so repo/store capabilities can override engine built-ins. Each
 * directory needs a readable `profile.json`; capability roots also require an
 * implementation `role`.
 */
export function listExecutables(roots: string | string[] = getExecutableRoots()): DiscoveredExecutable[] {
  const rootList = typeof roots === "string" ? [roots] : roots
  const seen = new Set<string>()
  const out: DiscoveredExecutable[] = []
  for (const root of rootList) {
    if (!fs.existsSync(root)) continue
    const requireImplementationProfile = isCapabilityRoot(root)
    const entries = fs.readdirSync(root, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      if (seen.has(ent.name)) continue // earlier root wins
      const profilePath = path.join(root, ent.name, CAPABILITY_PROFILE_FILE)
      if (
        fs.existsSync(profilePath) &&
        fs.statSync(profilePath).isFile() &&
        isImplementationProfile(profilePath, requireImplementationProfile)
      ) {
        out.push({ name: ent.name, profilePath })
        seen.add(ent.name)
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve a single implementation profile by name across all roots. Returns
 * the first matching `profile.json` path, or null if nothing matches.
 */
export function resolveExecutable(name: string, roots: string | string[] = getExecutableRoots()): string | null {
  if (!isSafeName(name)) return null
  const rootList = typeof roots === "string" ? [roots] : roots
  for (const root of rootList) {
    const profilePath = path.join(root, name, "profile.json")
    if (
      fs.existsSync(profilePath) &&
      fs.statSync(profilePath).isFile() &&
      isImplementationProfile(profilePath, isCapabilityRoot(root))
    ) {
      return profilePath
    }
  }
  return null
}

/** Convenience: true iff `<name>/profile.json` exists in any root. */
export function hasExecutable(name: string, roots: string | string[] = getExecutableRoots()): boolean {
  return resolveExecutable(name, roots) !== null
}

/**
 * List public capability actions. The legacy function name stays until the
 * compatibility layer is removed. Ordering is intentional: project
 * capabilities override company-store capabilities, then engine built-ins.
 */
export function listCapabilityActions(
  projectCapabilitiesRoot: string = getProjectCapabilitiesRoot(),
): DiscoveredCapabilityAction[] {
  const seen = new Set<string>()
  const out: DiscoveredCapabilityAction[] = []
  const add = (action: DiscoveredCapabilityAction) => {
    if (!isSafeName(action.action) || !isSafeName(action.capability) || !isSafeName(action.executable)) return
    if (seen.has(action.action)) return
    seen.add(action.action)
    out.push(action)
  }

  for (const action of listFolderCapabilityActions(projectCapabilitiesRoot, "project-folder")) add(action)
  const storeCapabilitiesRoot = getCompanyStoreCapabilitiesRoot()
  if (storeCapabilitiesRoot) {
    for (const action of listFolderCapabilityActions(storeCapabilitiesRoot, "company-store")) add(action)
  }
  for (const action of listBuiltinCapabilityActions(getBuiltinCapabilitiesRoot())) add(action)
  return out.sort((a, b) => a.action.localeCompare(b.action))
}

/** Resolve one public action to the capability that owns it. */
export function resolveCapabilityAction(
  action: string,
  projectCapabilitiesRoot: string = getProjectCapabilitiesRoot(),
): DiscoveredCapabilityAction | null {
  if (!isSafeName(action)) return null
  return listCapabilityActions(projectCapabilitiesRoot).find((d) => d.action === action) ?? null
}

export function hasCapabilityAction(
  action: string,
  projectCapabilitiesRoot: string = getProjectCapabilitiesRoot(),
): boolean {
  return resolveCapabilityAction(action, projectCapabilitiesRoot) !== null
}

export function resolveCapabilityFolder(
  slug: string,
  projectCapabilitiesRoot: string = getProjectCapabilitiesRoot(),
): CapabilityFolder | null {
  if (!isSafeName(slug)) return null
  for (const root of getCapabilityRoots(projectCapabilitiesRoot)) {
    const capability = readCapabilityFolder(root, slug)
    if (capability) return capability
  }
  return null
}

/** Read the implementation profile inputs for a public capability action. */
export function getCapabilityActionInputs(action: string): InputSpec[] | null {
  const resolved = resolveCapabilityAction(action)
  if (!resolved) return null
  return getProfileInputs(resolved.executable)
}

export function resolveCapabilityExecution(capability: CapabilityFolder): {
  executable: string
  cliArgs: Record<string, unknown>
} {
  const firstWorkflowStep = capability.config.workflow?.steps[0]
  if (firstWorkflowStep) {
    return { executable: firstWorkflowStep.executable ?? firstWorkflowStep.capability, cliArgs: {} }
  }
  const executable =
    capability.config.implementation ??
    capability.config.executable ??
    capability.config.implementations?.[0] ??
    capability.config.executables?.[0] ??
    (capability.config.role ? capability.slug : undefined) ??
    (capability.config.tickScript ? "capability-tick-scripted" : "capability-tick")
  const cliArgs = executableDeclaresInput(executable, "capability") ? { capability: capability.slug } : {}
  return { executable, cliArgs }
}

function executableDeclaresInput(executable: string, inputName: string): boolean {
  const profilePath = resolveExecutable(executable)
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

/** Executable names: lowercase letters, digits, and dashes. Rejects traversal. */
export function isSafeName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name) && !name.includes("..")
}

function isCapabilityRoot(root: string): boolean {
  const normalized = path.normalize(root)
  if (path.basename(normalized) === "capabilities") return true

  const knownRoots = [getProjectCapabilitiesRoot(), getCompanyStoreCapabilitiesRoot(), getBuiltinCapabilitiesRoot()]
  return knownRoots.some((candidate) => candidate && path.normalize(candidate) === normalized)
}

function isImplementationProfile(profilePath: string, requireImplementationProfile: boolean): boolean {
  if (!requireImplementationProfile) return true
  try {
    const raw = JSON.parse(fs.readFileSync(profilePath, "utf-8")) as { role?: unknown }
    return typeof raw.role === "string" && PUBLIC_EXECUTABLE_ROLES.has(raw.role)
  } catch {
    return false
  }
}

function listFolderCapabilityActions(
  root: string,
  source: "project-folder" | "company-store",
): DiscoveredCapabilityAction[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: DiscoveredCapabilityAction[] = []
  for (const slug of listCapabilityFolderSlugs(root)) {
    if (!isSafeName(slug)) continue
    const capability = readCapabilityFolder(root, slug)
    if (!capability) continue
    if (capability.config.internal === true || capability.config.public === false) continue
    const action = capability.config.action ?? slug
    const { executable, cliArgs } = resolveCapabilityExecution(capability)
    if (hasUnresolvedExplicitImplementation(capability, executable)) continue
    out.push({
      action,
      capability: slug,
      executable,
      cliArgs,
      source,
      describe: capability.config.describe ?? capability.title,
      profilePath: capability.profilePath,
      bodyPath: capability.bodyPath,
    })
  }
  return out.sort((a, b) => a.action.localeCompare(b.action))
}

function hasUnresolvedExplicitImplementation(capability: CapabilityFolder, executable: string): boolean {
  const config = capability.config
  const hasExplicitImplementation =
    Boolean(config.implementation || config.executable) ||
    (config.implementations?.length ?? 0) > 0 ||
    (config.executables?.length ?? 0) > 0
  if (!hasExplicitImplementation) return false
  if (config.workflow?.steps.length) return false
  if (config.role && PUBLIC_EXECUTABLE_ROLES.has(config.role)) return false
  return resolveExecutable(executable) === null
}

function listBuiltinCapabilityActions(root: string = getBuiltinCapabilitiesRoot()): DiscoveredCapabilityAction[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: DiscoveredCapabilityAction[] = []
  for (const slug of listCapabilityFolderSlugs(root)) {
    if (!isSafeName(slug)) continue
    const capability = readCapabilityFolder(root, slug)
    if (!capability) continue
    const action = capability.config.action ?? slug
    const executable = capability.config.implementation ?? capability.config.executable ?? slug
    out.push({
      action,
      capability: slug,
      executable,
      cliArgs: {},
      source: "builtin",
      describe: capability.config.describe ?? capability.title,
      profilePath: capability.profilePath,
      bodyPath: capability.bodyPath,
    })
  }
  return out.sort((a, b) => a.action.localeCompare(b.action))
}

/**
 * Light-weight profile inspector: returns an executable's declared `inputs`
 * without running the full profile validator. Dispatch uses this to drive
 * comment-argument parsing entirely from profile metadata. Returns null if
 * the executable doesn't exist or the profile is unreadable (dispatch
 * should degrade gracefully, not throw).
 */
export function getProfileInputs(name: string, roots: string | string[] = getExecutableRoots()): InputSpec[] | null {
  const profilePath = resolveExecutable(name, roots)
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
 * Minimal generic flag parser for auto-discovered executables.
 * Supports `--key value` and `--flag` (boolean). Unknown positionals
 * accumulate in `args._` for the executable to reject if it wishes.
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
