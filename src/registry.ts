/**
 * Engine asset auto-discovery.
 *
 * Two asset families live alongside each other:
 *
 * - **Executables** (`.kody/executables/<name>/profile.json` in project/store,
 *   plus minimal engine built-ins) implementation units selected by duties.
 *   - **Duties** (`.kody/duties/<slug>/profile.json` + `duty.md`) — public
 *     work units and operator-facing actions. Duty discovery is handled by
 *     `listDutyActions()`, not by executable resolution.
 *
 * Both follow the same dev/built path-resolution pattern so `src/` and
 * `dist/` layouts work identically.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { getCompanyStoreAssetRoot } from "./companyStore.js"
import type { DutyFolder } from "./dutyFolders.js"
import { DUTY_PROFILE_FILE, listDutyFolderSlugs, readDutyFolder } from "./dutyFolders.js"
import type { InputSpec } from "./executables/types.js"

const PUBLIC_EXECUTABLE_ACTION_ROLES = new Set(["primitive", "orchestrator", "container", "watch", "utility"])
const PUBLIC_EXECUTABLE_CAPABILITY_KINDS = new Set(["observe", "act", "verify"])

export interface DiscoveredExecutable {
  name: string
  profilePath: string
}

export interface DiscoveredDutyAction {
  /** Public action typed by a user, e.g. `@kody run`. */
  action: string
  /** Duty slug that owns the public action. */
  duty: string
  /** Implementation executable selected by the duty. */
  executable: string
  /** Extra args required to lower the duty to its implementation. */
  cliArgs: Record<string, unknown>
  source: "project-folder" | "project-executable" | "company-store" | "company-store-executable" | "builtin"
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
 * Resolve the consumer-repo executables root. Looks for `.kody/executables/`
 * relative to the current working directory (the engine runs from the
 * consumer repo's checkout). Returns the path even if it doesn't exist;
 * callers must check.
 */
export function getProjectExecutablesRoot(): string {
  return path.join(process.cwd(), ".kody", "executables")
}

/**
 * Resolve the consumer-repo duties root (`.kody/duties/`). A duty is a public
 * work unit: it owns action/purpose and selects an implementation executable.
 * Returns the path even if it doesn't exist; callers must check.
 */
export function getProjectDutiesRoot(): string {
  return path.join(process.cwd(), ".kody", "duties")
}

export function getCompanyStoreExecutablesRoot(): string | null {
  return getCompanyStoreAssetRoot("executables")
}

export function getCompanyStoreDutiesRoot(): string | null {
  return getCompanyStoreAssetRoot("duties")
}

export function getBuiltinDutiesRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const candidates = [
    path.join(here, "duties"), // dev: src/
    path.join(here, "..", "duties"), // built: dist/bin → dist/duties
    path.join(here, "..", "src", "duties"), // fallback
  ]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c
  }
  return candidates[0]!
}

/**
 * Ordered list of executable roots, project first, engine second. Project
 * roots override engine roots on name conflict — the consumer repo always
 * wins. Engine ships a stdlib; project repos can override or add private
 * implementation units under `.kody/executables/<name>/`.
 */
export function getExecutableRoots(): string[] {
  const storeRoot = getCompanyStoreExecutablesRoot()
  return [getProjectExecutablesRoot(), ...(storeRoot ? [storeRoot] : []), getExecutablesRoot()]
}

export function getDutyRoots(projectDutiesRoot: string = getProjectDutiesRoot()): string[] {
  const storeRoot = getCompanyStoreDutiesRoot()
  return [projectDutiesRoot, ...(storeRoot ? [storeRoot] : []), getBuiltinDutiesRoot()]
}

/**
 * Names of the engine-bundled executables (the dir names under the engine root
 * that contain a profile.json). Cached — the engine root never changes within a
 * process. Used to stop a consumer `.kody/duties/<name>/` folder from silently
 * shadowing an engine builtin (run/merge/serve/duty-scheduler/…).
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

/** True iff `name` is an engine-bundled executable that duties must not shadow. */
export function isBuiltinExecutable(name: string): boolean {
  return builtinExecutableNames().has(name)
}

/**
 * List every discovered executable across executable roots. On name conflict
 * the first root wins, so a `.kody/executables/chat/` in the consumer repo
 * shadows the engine's `chat`. Each needs a directory containing a readable
 * `profile.json`. Directories without one are silently skipped.
 */
export function listExecutables(roots: string | string[] = getExecutableRoots()): DiscoveredExecutable[] {
  const rootList = typeof roots === "string" ? [roots] : roots
  const seen = new Set<string>()
  const out: DiscoveredExecutable[] = []
  for (const root of rootList) {
    if (!fs.existsSync(root)) continue
    const entries = fs.readdirSync(root, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      if (seen.has(ent.name)) continue // earlier root wins
      const profilePath = path.join(root, ent.name, DUTY_PROFILE_FILE)
      if (fs.existsSync(profilePath) && fs.statSync(profilePath).isFile()) {
        out.push({ name: ent.name, profilePath })
        seen.add(ent.name)
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve a single executable by name across all roots. Returns the first
 * matching `profile.json` path, or null if nothing matches.
 */
export function resolveExecutable(name: string, roots: string | string[] = getExecutableRoots()): string | null {
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
export function hasExecutable(name: string, roots: string | string[] = getExecutableRoots()): boolean {
  return resolveExecutable(name, roots) !== null
}

/**
 * List public duty actions. Duties own the operator-facing action name; an
 * executable is only the selected implementation. Ordering is intentional:
 * project folder duties override company store duties, which override
 * engine built-ins.
 */
export function listDutyActions(projectDutiesRoot: string = getProjectDutiesRoot()): DiscoveredDutyAction[] {
  const seen = new Set<string>()
  const out: DiscoveredDutyAction[] = []
  const add = (action: DiscoveredDutyAction) => {
    if (!isSafeName(action.action) || !isSafeName(action.duty) || !isSafeName(action.executable)) return
    if (seen.has(action.action)) return
    seen.add(action.action)
    out.push(action)
  }

  const roots = getDutyRoots(projectDutiesRoot)
  const executableRoots = getExecutableRoots()
  for (const action of listFolderDutyActions(roots[0]!, "project-folder")) add(action)
  for (const action of listExecutableDutyActions(executableRoots[0]!, "project-executable")) add(action)
  if (roots.length === 3) {
    for (const action of listFolderDutyActions(roots[1]!, "company-store")) add(action)
    for (const action of listExecutableDutyActions(executableRoots[1]!, "company-store-executable")) add(action)
    for (const action of listBuiltinDutyActions(roots[2]!)) add(action)
  } else {
    for (const action of listBuiltinDutyActions(roots[1]!)) add(action)
  }
  return out.sort((a, b) => a.action.localeCompare(b.action))
}

/** Resolve one public action to the duty that owns it. */
export function resolveDutyAction(
  action: string,
  projectDutiesRoot: string = getProjectDutiesRoot(),
): DiscoveredDutyAction | null {
  if (!isSafeName(action)) return null
  return listDutyActions(projectDutiesRoot).find((d) => d.action === action) ?? null
}

export function hasDutyAction(action: string, projectDutiesRoot: string = getProjectDutiesRoot()): boolean {
  return resolveDutyAction(action, projectDutiesRoot) !== null
}

export function resolveDutyFolder(slug: string, projectDutiesRoot: string = getProjectDutiesRoot()): DutyFolder | null {
  if (!isSafeName(slug)) return null
  for (const root of getDutyRoots(projectDutiesRoot)) {
    const duty = readDutyFolder(root, slug)
    if (duty) return duty
  }
  return null
}

/** Read the implementation profile inputs for a public duty action. */
export function getDutyActionInputs(action: string): InputSpec[] | null {
  const resolved = resolveDutyAction(action)
  if (!resolved) return null
  return getProfileInputs(resolved.executable)
}

export function resolveDutyExecution(duty: DutyFolder): { executable: string; cliArgs: Record<string, unknown> } {
  const executable =
    duty.config.executable ??
    duty.config.executables?.[0] ??
    (duty.config.tickScript ? "duty-tick-scripted" : "duty-tick")
  const cliArgs = executableDeclaresInput(executable, "duty") ? { duty: duty.slug } : {}
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

function listExecutableDutyActions(
  root: string,
  source: "project-executable" | "company-store-executable",
): DiscoveredDutyAction[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: DiscoveredDutyAction[] = []
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || !isSafeName(ent.name)) continue
    const profilePath = path.join(root, ent.name, DUTY_PROFILE_FILE)
    if (!fs.existsSync(profilePath) || !fs.statSync(profilePath).isFile()) continue
    try {
      const raw = JSON.parse(fs.readFileSync(profilePath, "utf-8")) as Record<string, unknown>
      const action = typeof raw.action === "string" && raw.action.trim() ? raw.action.trim() : ""
      if (!action) continue
      if (!PUBLIC_EXECUTABLE_ACTION_ROLES.has(String(raw.role))) continue
      if (!PUBLIC_EXECUTABLE_CAPABILITY_KINDS.has(String(raw.capabilityKind))) continue
      if (!Array.isArray(raw.inputs)) continue
      out.push({
        action,
        duty: ent.name,
        executable: ent.name,
        cliArgs: {},
        source,
        describe: typeof raw.describe === "string" ? raw.describe : undefined,
        profilePath,
      })
    } catch {}
  }
  return out.sort((a, b) => a.action.localeCompare(b.action))
}

function listFolderDutyActions(root: string, source: "project-folder" | "company-store"): DiscoveredDutyAction[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: DiscoveredDutyAction[] = []
  for (const slug of listDutyFolderSlugs(root)) {
    if (!isSafeName(slug)) continue
    const duty = readDutyFolder(root, slug)
    if (!duty) continue
    const action = duty.config.action ?? slug
    const { executable, cliArgs } = resolveDutyExecution(duty)
    out.push({
      action,
      duty: slug,
      executable,
      cliArgs,
      source,
      describe: duty.config.describe ?? duty.title,
      profilePath: duty.profilePath,
      bodyPath: duty.bodyPath,
    })
  }
  return out.sort((a, b) => a.action.localeCompare(b.action))
}

function listBuiltinDutyActions(root: string = getBuiltinDutiesRoot()): DiscoveredDutyAction[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: DiscoveredDutyAction[] = []
  for (const slug of listDutyFolderSlugs(root)) {
    if (!isSafeName(slug)) continue
    const duty = readDutyFolder(root, slug)
    if (!duty) continue
    const action = duty.config.action ?? slug
    const executable = duty.config.executable ?? slug
    out.push({
      action,
      duty: slug,
      executable,
      cliArgs: {},
      source: "builtin",
      describe: duty.config.describe ?? duty.title,
      profilePath: duty.profilePath,
      bodyPath: duty.bodyPath,
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
