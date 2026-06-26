/**
 * Read the dashboard-managed per-repo variables file. The durable copy lives at
 * `variables.json` in the configured state repo; engine runs hydrate it into
 * `.kody/variables.json` as a local compatibility cache.
 *
 * On-disk shape:
 *   { "version": 1, "variables": { "NAME": { "value": "...", "updatedAt": "...", "updatedBy": "..." } } }
 *
 * Returns a flat { NAME: value } map. Missing file, unreadable file, or
 * unparseable JSON all degrade to {} — variables are an optional, fail-soft
 * input (the QA executables work with no credentials at all).
 */

import * as fs from "node:fs"
import * as path from "node:path"

export const KODY_VARIABLES_REL_PATH = ".kody/variables.json"

interface VariablesDocument {
  version?: number
  variables?: Record<string, { value?: unknown }>
}

export function readKodyVariables(cwd: string): Record<string, string> {
  const full = path.join(cwd, KODY_VARIABLES_REL_PATH)
  let raw: string
  try {
    raw = fs.readFileSync(full, "utf-8")
  } catch {
    return {}
  }
  let doc: VariablesDocument
  try {
    doc = JSON.parse(raw) as VariablesDocument
  } catch {
    return {}
  }
  const flat: Record<string, string> = {}
  for (const [name, entry] of Object.entries(doc.variables ?? {})) {
    if (entry && typeof entry.value === "string") flat[name] = entry.value
  }
  return flat
}
