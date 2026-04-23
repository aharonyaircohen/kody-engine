/**
 * Kody labels — mechanism-only helper. No executable, phase, or group
 * names live here: every label is declared inline by whichever profile
 * wants it (via a script entry's `with` block). This module just:
 *
 *   - collects label specs from the profile set,
 *   - ensures them in the target repo,
 *   - applies one to an issue/PR with same-group mutex.
 *
 * Rules:
 *   - A label is kody-owned iff its name starts with `KODY_NAMESPACE`.
 *     Non-kody labels are ignored (never created, never removed).
 *   - Two kody-owned labels share an exclusivity group iff they share
 *     the same prefix up to and including the first `:`. Setting one
 *     removes any same-group sibling on the target; different-group
 *     labels coexist.
 *   - Labels without a `:` are in their own degenerate group (just the
 *     whole name); they will never conflict with a prefixed label.
 *
 * Public surface:
 *   - setKodyLabel(n, spec, cwd): set the label on issue/PR #n, lazy-
 *     creating via spec's color/description if `gh` reports it missing.
 *   - collectProfileLabels(): walk every profile's script entries and
 *     harvest `{label, color, description}` from their `with` blocks.
 *   - ensureLabels(cwd): at init time, `gh label create --force` every
 *     collected spec. Best-effort, never throws.
 */

import { gh } from "./issue.js"
import { loadProfile } from "./profile.js"
import { listExecutables } from "./registry.js"
import type { ScriptEntry } from "./executables/types.js"

/** Namespace prefix — labels starting with this are kody-owned and safe to touch. */
export const KODY_NAMESPACE = "kody"

/**
 * Extract a label's exclusivity group: everything up to and including
 * the first `:`. A label with no `:` is its own group (whole name).
 */
function groupOf(label: string): string {
  const idx = label.indexOf(":")
  return idx === -1 ? label : label.slice(0, idx + 1)
}

export interface KodyLabelSpec {
  label: string
  color?: string
  description?: string
}

export interface EnsureLabelsResult {
  created: string[]
  failed: Array<{ label: string; reason: string }>
}

/**
 * Walk every executable profile and harvest label specs declared on
 * script entries' `with` blocks. Deduped by label name — last writer
 * wins on conflicting color/description (shouldn't happen in practice).
 */
export function collectProfileLabels(): KodyLabelSpec[] {
  const byLabel = new Map<string, KodyLabelSpec>()
  for (const exe of listExecutables()) {
    let profile: ReturnType<typeof loadProfile>
    try {
      profile = loadProfile(exe.profilePath)
    } catch {
      continue
    }
    for (const entry of [...profile.scripts.preflight, ...profile.scripts.postflight]) {
      const spec = extractLabelSpec(entry)
      if (spec) byLabel.set(spec.label, spec)
    }
  }
  return [...byLabel.values()]
}

function extractLabelSpec(entry: ScriptEntry): KodyLabelSpec | null {
  const w = entry.with
  if (!w) return null
  const label = typeof w.label === "string" ? w.label : null
  if (!label || !label.startsWith(KODY_NAMESPACE)) return null
  return {
    label,
    color: typeof w.color === "string" ? w.color : undefined,
    description: typeof w.description === "string" ? w.description : undefined,
  }
}

/**
 * Create (or update via --force) every kody-owned label declared across
 * the profile set. Best-effort per label — each failure is captured in
 * the result, nothing throws.
 */
export function ensureLabels(cwd?: string): EnsureLabelsResult {
  const result: EnsureLabelsResult = { created: [], failed: [] }
  for (const spec of collectProfileLabels()) {
    try {
      createLabelInRepo(spec, cwd)
      result.created.push(spec.label)
    } catch (err) {
      result.failed.push({ label: spec.label, reason: errMsg(err) })
    }
  }
  return result
}

export function getIssueLabels(issueNumber: number, cwd?: string): string[] {
  try {
    const output = gh(
      ["issue", "view", String(issueNumber), "--json", "labels", "--jq", ".labels[].name"],
      { cwd },
    )
    return output.split("\n").filter(Boolean)
  } catch {
    return []
  }
}

function addLabel(issueNumber: number, label: string, cwd?: string): void {
  gh(["issue", "edit", String(issueNumber), "--add-label", label], { cwd })
}

function removeLabel(issueNumber: number, label: string, cwd?: string): void {
  try {
    gh(["issue", "edit", String(issueNumber), "--remove-label", label], { cwd })
  } catch {
    // Label not present on issue — fine.
  }
}

function createLabelInRepo(spec: KodyLabelSpec, cwd?: string): void {
  const args = ["label", "create", spec.label, "--force"]
  if (spec.color) args.push("--color", spec.color)
  if (spec.description) args.push("--description", spec.description)
  gh(args, { cwd })
}

/**
 * Set `spec.label` on issue/PR #n, removing any same-group kody sibling
 * present (group = prefix up to first `:`). Different groups coexist.
 * Best-effort: failures log but never throw. If the target label doesn't
 * exist in the repo yet, creates it (using spec's color/description)
 * and retries once.
 */
export function setKodyLabel(issueNumber: number, spec: KodyLabelSpec, cwd?: string): void {
  const target = spec.label
  if (!target.startsWith(KODY_NAMESPACE)) {
    process.stderr.write(
      `[kody] setKodyLabel: refusing to set non-kody label "${target}"\n`,
    )
    return
  }

  const targetGroup = groupOf(target)
  const present = getIssueLabels(issueNumber, cwd)
  for (const label of present) {
    if (label !== target && label.startsWith(KODY_NAMESPACE) && groupOf(label) === targetGroup) {
      removeLabel(issueNumber, label, cwd)
    }
  }

  try {
    addLabel(issueNumber, target, cwd)
  } catch (err) {
    if (looksLikeMissingLabel(err)) {
      try {
        createLabelInRepo(spec, cwd)
        addLabel(issueNumber, target, cwd)
        return
      } catch (retryErr) {
        process.stderr.write(
          `[kody] setKodyLabel: create+retry failed for ${target} on #${issueNumber}: ${errMsg(retryErr)}\n`,
        )
        return
      }
    }
    process.stderr.write(
      `[kody] setKodyLabel: failed to add ${target} on #${issueNumber}: ${errMsg(err)}\n`,
    )
  }
}

function looksLikeMissingLabel(err: unknown): boolean {
  const msg = errMsg(err).toLowerCase()
  return (
    msg.includes("not found") ||
    msg.includes("could not add label") ||
    msg.includes("could not resolve to a label")
  )
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "object" && err !== null) {
    const e = err as { stderr?: Buffer | string; message?: string }
    const stderr = e.stderr?.toString().trim()
    if (stderr) return stderr
    if (e.message) return e.message
  }
  return String(err)
}
