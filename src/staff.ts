/**
 * Load a staff member's persona for an executable that declares `staff:`.
 *
 * This is the generic, executor-level version of what the duty/tick path does
 * per-executable via the `{{workerPersona}}` prompt token (see
 * loadJobFromFile.ts / loadWorkerAdhoc.ts). A `staff` field on any profile lets
 * the executor run that executable *as* a named staff member — the unification
 * step: a "duty" is just an executable + a staff member.
 *
 * Resolution mirrors the duty path: `.kody/staff/<slug>.md`, frontmatter
 * stripped, body returned. A declared-but-missing staff file is fatal — an
 * executable must never silently run without the identity it asked for.
 */

import * as fs from "node:fs"
import * as path from "node:path"

const DEFAULT_STAFF_DIR = ".kody/staff"

/** Strip a leading `---\n…\n---\n` frontmatter block; return the body. */
function stripFrontmatter(raw: string): string {
  const match = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(raw)
  return (match ? match[1]! : raw).trim()
}

/**
 * Read the persona body for `slug` from `<cwd>/<staffDir>/<slug>.md`.
 * Throws if the file is missing or empty — a declared staff member must exist.
 */
export function loadStaffPersona(cwd: string, slug: string, staffDir: string = DEFAULT_STAFF_DIR): string {
  const trimmed = slug.trim()
  if (!trimmed) throw new Error("loadStaffPersona: empty staff slug")
  const staffPath = path.join(cwd, staffDir, `${trimmed}.md`)
  if (!fs.existsSync(staffPath)) {
    throw new Error(`loadStaffPersona: staff '${trimmed}' declared but ${staffPath} does not exist`)
  }
  const body = stripFrontmatter(fs.readFileSync(staffPath, "utf-8"))
  if (!body) throw new Error(`loadStaffPersona: staff '${trimmed}' persona body is empty (${staffPath})`)
  return body
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
