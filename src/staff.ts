/**
 * Load a staff member's persona for an executable that declares `staff:`.
 *
 * This is the generic, executor-level version of what the duty/tick path does
 * via the `{{workerPersona}}` prompt token (see loadJobFromFile.ts /
 * loadWorkerAdhoc.ts). A `staff` field on a profile lets the executor run that
 * executable *as* a named staff member.
 *
 * Resolution mirrors the duty path: `.kody/staff/<slug>.md`, frontmatter
 * stripped, body returned. A declared-but-missing staff file is fatal — an
 * executable must never silently run without the identity it asked for.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { getCompanyStoreAssetRoot } from "./companyStore.js"

const DEFAULT_STAFF_DIR = ".kody/staff"

/** Staff personas live in project `.kody/staff` or the configured company store. */
export const BUILTIN_PERSONAS: Record<string, string> = {}

/** Strip a leading `---\n…\n---\n` frontmatter block; return the body. */
function stripFrontmatter(raw: string): string {
  const match = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(raw)
  return (match ? match[1]! : raw).trim()
}

/**
 * Read the persona body for `slug`.
 *
 * Resolution order:
 * 1. Consumer file `<cwd>/<staffDir>/<slug>.md` (non-empty) — always wins.
 * 2. Company store staff file.
 * 3. Otherwise throw — declared staff member with no source must not run.
 */
export function loadStaffPersona(cwd: string, slug: string, staffDir: string = DEFAULT_STAFF_DIR): string {
  const trimmed = slug.trim()
  if (!trimmed) throw new Error("loadStaffPersona: empty staff slug")
  const staffPath = resolveStaffPersonaFile(cwd, trimmed, staffDir)
  if (fs.existsSync(staffPath)) {
    const body = stripFrontmatter(fs.readFileSync(staffPath, "utf-8"))
    if (body) return body
    // File present but empty: fall back to a built-in if one exists, else
    // preserve the legacy "body is empty" error.
    const builtinForEmpty = BUILTIN_PERSONAS[trimmed]
    if (builtinForEmpty) return builtinForEmpty
    throw new Error(`loadStaffPersona: staff '${trimmed}' persona body is empty (${staffPath})`)
  }
  const builtin = BUILTIN_PERSONAS[trimmed]
  if (builtin) return builtin
  throw new Error(`loadStaffPersona: staff '${trimmed}' declared but ${staffPath} does not exist`)
}

export function resolveStaffPersonaFile(cwd: string, slug: string, staffDir: string = DEFAULT_STAFF_DIR): string {
  const localPath = path.join(cwd, staffDir, `${slug}.md`)
  if (fs.existsSync(localPath)) return localPath

  const storeStaffRoot = getCompanyStoreAssetRoot("staff")
  if (storeStaffRoot) {
    const storePath = path.join(storeStaffRoot, `${slug}.md`)
    if (fs.existsSync(storePath)) return storePath
  }

  return localPath
}

/**
 * Wrap a persona body in the authoritative-identity framing the agent expects,
 * matching worker-ask's prompt. Returned block is meant to lead the executable's
 * system-prompt append so identity sits ahead of task-specific instructions.
 */
export function framePersona(slug: string, persona: string): string {
  return [
    `## Who you are — staff persona (authoritative identity)`,
    ``,
    `You are operating as staff member \`${slug}\`. This persona defines *who* you are:`,
    `your authority, doctrine, voice, and hard limits. Honour it exactly. Where the`,
    `persona's restrictions are stricter than the task, **the persona wins** — a task`,
    `can never grant you authority your persona withholds.`,
    ``,
    persona,
  ].join("\n")
}
