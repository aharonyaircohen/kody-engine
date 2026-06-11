/**
 * Engine asset auto-discovery.
 *
 * Two asset families live alongside each other:
 *
 *   - **Executables** (`src/executables/<name>/profile.json`) — units the
 *     dispatcher invokes by name. `listExecutables()` powers `entry.ts` so
 *     dropping a new directory makes `kody <name>` work without router edits.
 *   - **Built-in duties** (`src/jobs/<slug>/profile.json` + `prompt.md`) —
 *     folder-duty templates that `kody init` scaffolds into consumer repos
 *     under `.kody/duties/<slug>/`. Once scaffolded, the consumer owns the
 *     folder; `duty-scheduler` / `dispatchDutyFileTicks` discover it from
 *     the consumer's `.kody/duties/` directly, not via this registry. The
 *     folder shape is the unified successor to the legacy `<slug>.md` file
 *     (still discovered for back-compat; the deprecation log is #46-B's job).
 *
 * Both follow the same dev/built path-resolution pattern so `src/` and
 * `dist/` layouts work identically.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { InputSpec } from "./executables/types.js"
import { splitFrontmatter } from "./scripts/jobFrontmatter.js"

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
  source: "project-folder" | "project-markdown" | "builtin"
  describe?: string
  profilePath?: string
  filePath?: string
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
 * Resolve the consumer-repo duties root (`.kody/duties/`). A duty is the
 * unified successor to an executable: a `<slug>/profile.json` folder that
 * additionally carries a `staff` member. Scheduled markdown duties
 * (`.kody/duties/<slug>.md`) live in the same directory but are plain files,
 * so the directory-only discovery skips them harmlessly. Returns the path
 * even if it doesn't exist; callers must check.
 */
export function getProjectDutiesRoot(): string {
  return path.join(process.cwd(), ".kody", "duties")
}

/**
 * Resolve the engine's built-in jobs root. Mirrors `getExecutablesRoot()` so
 * dev (`src/jobs`) and built (`dist/jobs`) layouts both work. Built-in jobs
 * are folder shapes (`<slug>/profile.json` + `prompt.md`) scaffolded into
 * consumer repos by `kody init`; drop a new folder under `src/jobs/<slug>/`
 * to ship a default. Legacy `<slug>.md` files are still discovered for
 * back-compat — the deprecation log + removal land in #46-B.
 */
export function getBuiltinJobsRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const candidates = [
    path.join(here, "jobs"), // dev: src/
    path.join(here, "..", "jobs"), // built: dist/bin → dist/jobs
    path.join(here, "..", "src", "jobs"), // fallback
  ]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c
  }
  return candidates[0]!
}

/** Built-in public duty-action definitions shipped with the engine. */
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

export interface BuiltinJob {
  slug: string
  /** Directory containing the built-in duty (the folder shape's root). */
  dir: string
  /** Absolute path to the folder's `profile.json`. */
  profilePath: string
  /** Absolute path to the folder's `prompt.md`. */
  promptPath: string
  /**
   * Absolute path to the legacy `.md` file, when present. Folder duties
   * leave this undefined; legacy markdown duties carry both a dir (the
   * containing folder) and a filePath, so the scaffolder can choose which
   * shape to copy.
   */
  filePath?: string
}

/**
 * List every built-in duty shipped with the engine. Returns
 * `{ slug, dir, profilePath, promptPath, filePath? }` for each duty under
 * the built-in jobs root. Folder shapes (preferred) require both
 * `profile.json` and `prompt.md`; legacy `.md` files are also discovered
 * with `filePath` set so callers can bridge the two shapes during the
 * migration.
 *
 * Sorted by slug. Used by `kody init` to scaffold default duties into
 * `.kody/duties/<slug>/` (folder shape) in consumer repos.
 */
export function listBuiltinJobs(root: string = getBuiltinJobsRoot()): BuiltinJob[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: BuiltinJob[] = []
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (ent.name.startsWith("_") || ent.name.startsWith(".")) continue
    const full = path.join(root, ent.name)
    if (ent.isDirectory()) {
      const profilePath = path.join(full, "profile.json")
      const promptPath = path.join(full, "prompt.md")
      if (!fs.existsSync(profilePath) || !fs.statSync(profilePath).isFile()) continue
      if (!fs.existsSync(promptPath) || !fs.statSync(promptPath).isFile()) continue
      out.push({ slug: ent.name, dir: full, profilePath, promptPath })
      continue
    }
    if (ent.isFile() && ent.name.endsWith(".md")) {
      const slug = ent.name.slice(0, -3)
      out.push({
        slug,
        dir: full,
        profilePath: "",
        promptPath: "",
        filePath: full,
      })
    }
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug))
  return out
}

/**
 * Ordered list of executable roots, project first, engine second. Project
 * roots override engine roots on name conflict — the consumer repo always
 * wins. Engine ships a stdlib (chat, run, plan, …); project repos can
 * override or add new executables under `.kody/executables/<name>/`.
 */
export function getExecutableRoots(): string[] {
  // Duties first: a `.kody/duties/<slug>/` folder is the unified successor and
  // wins over a same-named `.kody/executables/<slug>/` during the migration.
  return [getProjectDutiesRoot(), getProjectExecutablesRoot(), getExecutablesRoot()]
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
 * List every discovered executable across all roots. On name conflict the
 * first root wins, so a `.kody/executables/chat/` in the consumer repo
 * shadows the engine's `chat`. Each needs a directory containing a readable
 * `profile.json`. Directories without one are silently skipped.
 *
 * Exception: a `.kody/duties/<name>/` folder is NOT allowed to shadow an engine
 * builtin (run/merge/…) — that's a reserved-name collision, never intended. The
 * legacy `.kody/executables/<name>/` override is still honoured (existing
 * design) and only the duties home is restricted.
 */
export function listExecutables(roots: string | string[] = getExecutableRoots()): DiscoveredExecutable[] {
  const rootList = typeof roots === "string" ? [roots] : roots
  const dutiesRoot = getProjectDutiesRoot()
  const seen = new Set<string>()
  const out: DiscoveredExecutable[] = []
  for (const root of rootList) {
    if (!fs.existsSync(root)) continue
    const entries = fs.readdirSync(root, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      if (seen.has(ent.name)) continue // earlier root wins
      if (root === dutiesRoot && isBuiltinExecutable(ent.name)) continue // duties can't shadow a builtin
      const profilePath = path.join(root, ent.name, "profile.json")
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
  const dutiesRoot = getProjectDutiesRoot()
  for (const root of rootList) {
    // A `.kody/duties/<builtin>/` folder must not shadow an engine builtin —
    // skip it so resolution falls through to the engine root.
    if (root === dutiesRoot && isBuiltinExecutable(name)) continue
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
 * project folder duties override project markdown duties, and project duties
 * override engine built-ins.
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

  for (const action of listProjectFolderDutyActions(projectDutiesRoot)) add(action)
  for (const action of listProjectMarkdownDutyActions(projectDutiesRoot)) add(action)
  for (const action of listBuiltinDutyActions()) add(action)
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

/** Read the implementation profile inputs for a public duty action. */
export function getDutyActionInputs(action: string): InputSpec[] | null {
  const resolved = resolveDutyAction(action)
  if (!resolved) return null
  return getProfileInputs(resolved.executable)
}

/** Executable names: lowercase letters, digits, and dashes. Rejects traversal. */
export function isSafeName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name) && !name.includes("..")
}

function listProjectFolderDutyActions(root: string): DiscoveredDutyAction[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: DiscoveredDutyAction[] = []
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith(".") || ent.name.startsWith("_")) continue
    if (!isSafeName(ent.name)) continue
    const profilePath = path.join(root, ent.name, "profile.json")
    if (!fs.existsSync(profilePath) || !fs.statSync(profilePath).isFile()) continue
    try {
      const raw = JSON.parse(fs.readFileSync(profilePath, "utf-8")) as Record<string, unknown>
      const action = stringOr(raw.action, ent.name)
      const executable = stringOr(raw.executable, ent.name)
      out.push({
        action,
        duty: ent.name,
        executable,
        cliArgs: {},
        source: "project-folder",
        describe: typeof raw.describe === "string" ? raw.describe : undefined,
        profilePath,
      })
    } catch {
      continue
    }
  }
  return out.sort((a, b) => a.action.localeCompare(b.action))
}

function listProjectMarkdownDutyActions(root: string): DiscoveredDutyAction[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: DiscoveredDutyAction[] = []
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue
    const duty = ent.name.slice(0, -3)
    if (!isSafeName(duty)) continue
    const filePath = path.join(root, ent.name)
    try {
      const raw = fs.readFileSync(filePath, "utf-8")
      const { frontmatter } = splitFrontmatter(raw)
      const action = frontmatter.action?.trim() || duty
      const implementation = markdownDutyImplementation(duty, frontmatter)
      out.push({
        action,
        duty,
        executable: implementation.executable,
        cliArgs: implementation.cliArgs,
        source: "project-markdown",
        filePath,
      })
    } catch {
      continue
    }
  }
  return out.sort((a, b) => a.action.localeCompare(b.action))
}

function markdownDutyImplementation(
  duty: string,
  frontmatter: ReturnType<typeof splitFrontmatter>["frontmatter"],
): {
  executable: string
  cliArgs: Record<string, unknown>
} {
  if (frontmatter.executable?.trim()) {
    return { executable: frontmatter.executable.trim(), cliArgs: {} }
  }
  if (frontmatter.executables?.length === 1 && frontmatter.executables[0]?.trim()) {
    return { executable: frontmatter.executables[0].trim(), cliArgs: {} }
  }
  if (frontmatter.tickScript?.trim()) {
    return { executable: "duty-tick-scripted", cliArgs: { duty } }
  }
  return { executable: "duty-tick", cliArgs: { duty } }
}

function listBuiltinDutyActions(root: string = getBuiltinDutiesRoot()): DiscoveredDutyAction[] {
  const filePath = path.join(root, "public-actions.json")
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return []
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"))
    if (!Array.isArray(raw)) return []
    const out: DiscoveredDutyAction[] = []
    for (const item of raw) {
      if (!item || typeof item !== "object") continue
      const r = item as Record<string, unknown>
      const duty = stringOr(r.duty, stringOr(r.name, ""))
      const action = stringOr(r.action, duty)
      const executable = stringOr(r.executable, duty)
      if (!duty || !action || !executable) continue
      out.push({
        action,
        duty,
        executable,
        cliArgs: {},
        source: "builtin",
        describe: typeof r.describe === "string" ? r.describe : undefined,
        filePath,
      })
    }
    return out.sort((a, b) => a.action.localeCompare(b.action))
  } catch {
    return []
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback
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
