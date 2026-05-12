#!/usr/bin/env tsx
/**
 * Script-catalog modularity check (WARN MODE).
 *
 * Invariant: `src/scripts/` is for cross-cutting utilities used by ≥2
 * executables. Solo-use scripts violate the invariant in CLAUDE.md.
 *
 * This check parses every `src/executables/*\/profile.json`, builds the
 * `script-name → [executables]` map, and prints solo-use scripts.
 *
 * Currently exits 0 even when violations exist (warn mode). When the
 * lifecycle refactor lands (see docs/script-catalog-dsl-refactor.md),
 * flip MODE to "error" to fail CI on new violations.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const MODE: "warn" | "error" = "warn"
const EXEC_DIR = "src/executables"

type ProfileEntry = { script?: string } | string

const usage = new Map<string, Set<string>>()

for (const name of readdirSync(EXEC_DIR)) {
  const dir = join(EXEC_DIR, name)
  if (!statSync(dir).isDirectory()) continue
  const profilePath = join(dir, "profile.json")
  let profile: { scripts?: { preflight?: ProfileEntry[]; postflight?: ProfileEntry[] } }
  try {
    profile = JSON.parse(readFileSync(profilePath, "utf8"))
  } catch {
    continue
  }
  const entries = [...(profile.scripts?.preflight ?? []), ...(profile.scripts?.postflight ?? [])]
  for (const e of entries) {
    const script = typeof e === "string" ? e : e.script
    if (!script || script.endsWith(".sh")) continue
    if (!usage.has(script)) usage.set(script, new Set())
    usage.get(script)!.add(name)
  }
}

const all = [...usage.entries()].map(([script, execs]) => ({ script, execs: [...execs].sort() }))
const solo = all.filter((x) => x.execs.length === 1).sort((a, b) => a.execs[0]!.localeCompare(b.execs[0]!) || a.script.localeCompare(b.script))
const two = all.filter((x) => x.execs.length === 2)
const shared = all.filter((x) => x.execs.length >= 3)

console.log(`\n[modularity] ${all.length} scripts referenced — ${solo.length} solo · ${two.length} two-use · ${shared.length} shared (3+)`)

if (solo.length > 0) {
  console.log(`\n[modularity] ${solo.length} solo-use scripts (violate CLAUDE.md invariant 2):`)
  let lastExec = ""
  for (const { script, execs } of solo) {
    const exec = execs[0]!
    if (exec !== lastExec) {
      console.log(`  ${exec}/`)
      lastExec = exec
    }
    console.log(`    - ${script}`)
  }
  console.log(`\n[modularity] Fix path: either (a) demote to a shell script colocated with the executable, (b) inline the logic, or (c) generalise so a second executable uses it. See docs/script-catalog-dsl-refactor.md.`)
}

if (MODE === "error" && solo.length > 0) {
  console.error(`\n[modularity] FAIL: ${solo.length} solo-use script(s). Set MODE = "warn" in scripts/check-script-modularity.ts to bypass.`)
  process.exit(1)
}
