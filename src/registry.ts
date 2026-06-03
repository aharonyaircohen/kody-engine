/**
 * Engine asset auto-discovery.
 *
 * Two asset families live alongside each other:
 *
 *   - **Executables** (`src/executables/<name>/profile.json`) — units the
 *     dispatcher invokes by name. `listExecutables()` powers `entry.ts` so
 *     dropping a new directory makes `kody <name>` work without router edits.
 *   - **Built-in jobs** (`src/jobs/<slug>.md`) — markdown templates that
 *     `kody init` scaffolds into consumer repos under `.kody/duties/`. Once
 *     scaffolded, the consumer owns the file; `job-scheduler` /
 *     `job-tick` discover it from the consumer's `.kody/duties/` directly,
 *     not via this registry.
 *
 * Both follow the same dev/built path-resolution pattern so `src/` and
 * `dist/` layouts work identically.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { InputSpec } from "./executables/types.js"

export interface DiscoveredExecutable {
  name: string
  profilePath: string
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
 * are markdown files scaffolded into consumer repos by `kody init` — drop a
 * new `src/jobs/<slug>.md` to ship a default job; no code changes required.
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

export interface BuiltinJob {
  slug: string
  filePath: string
}

/**
 * List every built-in job markdown file shipped with the engine. Returns
 * `{ slug, filePath }` for each `.md` file under the built-in jobs root,
 * sorted by slug. Used by `kody init` to scaffold default jobs into
 * `.kody/duties/<slug>.md` in consumer repos.
 */
export function listBuiltinJobs(root: string = getBuiltinJobsRoot()): BuiltinJob[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: BuiltinJob[] = []
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue
    const slug = ent.name.slice(0, -3)
    out.push({ slug, filePath: path.join(root, ent.name) })
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
 * List every discovered executable across all roots. On name conflict the
 * first root wins, so a `.kody/executables/chat/` in the consumer repo
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

/** Executable names: lowercase letters, digits, and dashes. Rejects traversal. */
export function isSafeName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name) && !name.includes("..")
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
