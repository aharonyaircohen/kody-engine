/**
 * Executable auto-discovery.
 *
 * Scans the filesystem for `<executables-root>/<name>/profile.json` and
 * returns the list of available executables. Lets `entry.ts` dispatch
 * purely by directory layout — drop a new `src/executables/<name>/` with
 * a `profile.json` and `kody2 <name>` works without any code change here
 * or in the router.
 */

import * as fs from "node:fs"
import * as path from "node:path"

export interface DiscoveredExecutable {
  name: string
  profilePath: string
}

/**
 * Resolve the executables root directory. Mirrors `resolveProfilePath`
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
 * List every discovered executable. Each needs a directory containing
 * a readable `profile.json`. Directories without one are silently skipped
 * (allows for shared modules like `executables/types.ts`).
 */
export function listExecutables(root: string = getExecutablesRoot()): DiscoveredExecutable[] {
  if (!fs.existsSync(root)) return []
  const entries = fs.readdirSync(root, { withFileTypes: true })
  const out: DiscoveredExecutable[] = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const profilePath = path.join(root, ent.name, "profile.json")
    if (fs.existsSync(profilePath) && fs.statSync(profilePath).isFile()) {
      out.push({ name: ent.name, profilePath })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Convenience: true iff `<root>/<name>/profile.json` exists. */
export function hasExecutable(name: string, root: string = getExecutablesRoot()): boolean {
  if (!isSafeName(name)) return false
  const profilePath = path.join(root, name, "profile.json")
  return fs.existsSync(profilePath) && fs.statSync(profilePath).isFile()
}

/** Executable names: lowercase letters, digits, and dashes. Rejects traversal. */
export function isSafeName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name) && !name.includes("..")
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
    const value: unknown = next !== undefined && !next.startsWith("--") ? (i++, next) : true
    args[key] = value
    if (key.includes("-")) {
      const camel = key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
      if (camel !== key && args[camel] === undefined) args[camel] = value
    }
  }
  if (positional.length > 0) args._ = positional
  return args
}
