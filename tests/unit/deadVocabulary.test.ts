/**
 * Guard: the engine source must not carry dead vocabulary.
 *
 * AGENTS.md declares certain terms retired — they were renamed away and any
 * surviving reference is stale (see the Vocabulary glossary). This test walks
 * src/ and fails if a banned token reappears, so a rename can't silently rot
 * back into the codebase via a copied docstring or example string.
 *
 *   - "kody-manager"  — the old issue-state marker/fence prefix; the state
 *                       comment is generic, not manager-specific.
 *   - "mission-tick" / "mission-scheduler" — the dead `mission-*` executable
 *                       family (renamed; no such executable exists).
 *
 * Scope is src/ only. Tests may use these strings as arbitrary fixtures.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const SRC_DIR = path.resolve(__dirname, "../../src")
const BANNED = ["kody-manager", "mission-tick", "mission-scheduler"]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && /\.(ts|md|json)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe("dead vocabulary", () => {
  it("no retired terms survive anywhere under src/", () => {
    const offenders: string[] = []
    for (const file of walk(SRC_DIR)) {
      const text = fs.readFileSync(file, "utf-8")
      for (const term of BANNED) {
        if (text.includes(term)) {
          offenders.push(`${path.relative(SRC_DIR, file)} → "${term}"`)
        }
      }
    }
    expect(offenders, `retired vocabulary found:\n${offenders.join("\n")}`).toEqual([])
  })
})
