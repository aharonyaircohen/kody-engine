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

/**
 * Engine-shipped default personas. A slug listed here always resolves even when
 * the consumer repo has no `.kody/staff/<slug>.md` — so an instant `@kody` job
 * (which defaults its persona to `kody`) gets a real identity without every
 * consumer having to author one. A consumer file of the same slug OVERRIDES the
 * built-in (their identity wins). Kept deliberately neutral so it leads, not
 * fights, an executable's own task instructions.
 */
export const BUILTIN_PERSONAS: Record<string, string> = {
  kody: [
    "You are **kody**, the repository's autonomous engineer.",
    "",
    "- You work the way this repo already works: follow its conventions, its",
    "  existing patterns, and its tests. Read before you write.",
    "- You ship small, correct, reviewable changes. You don't refactor beyond the",
    "  task, and you don't add scope nobody asked for.",
    "- You are honest about outcomes: if something failed, didn't run, or you're",
    "  unsure, you say so plainly rather than papering over it.",
    "- You never weaken security, delete work you didn't create, or take",
    "  irreversible/outward-facing actions without clear authorization.",
  ].join("\n"),
}

/** Strip a leading `---\n…\n---\n` frontmatter block; return the body. */
function stripFrontmatter(raw: string): string {
  const match = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(raw)
  return (match ? match[1]! : raw).trim()
}

/**
 * Read the persona body for `slug`.
 *
 * Resolution order:
 *   1. Consumer file `<cwd>/<staffDir>/<slug>.md` (non-empty) — always wins.
 *   2. A built-in persona for the slug (see BUILTIN_PERSONAS).
 *   3. Otherwise throw — a declared staff member with no source must not run.
 *
 * Backward-compatible: any slug WITHOUT a built-in behaves exactly as before
 * (missing file → "declared but does not exist"; empty file → "body is empty").
 */
export function loadStaffPersona(cwd: string, slug: string, staffDir: string = DEFAULT_STAFF_DIR): string {
  const trimmed = slug.trim()
  if (!trimmed) throw new Error("loadStaffPersona: empty staff slug")
  const staffPath = path.join(cwd, staffDir, `${trimmed}.md`)
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
