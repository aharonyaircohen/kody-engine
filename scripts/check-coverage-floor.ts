#!/usr/bin/env tsx
/**
 * Per-file 0%-coverage floor (ERROR MODE) — the guard vitest can't express.
 *
 * The repo's coverage gate is an AGGREGATE ratchet (vitest.config.ts). That
 * lets a brand-new, wholly-untested module land freely: one 0%-covered file
 * barely moves a 9,000-statement aggregate, so the global threshold never
 * notices. vitest can't combine an aggregate ratchet with a per-file floor in
 * one config (its glob thresholds only act per-file when the global `perFile`
 * flag is on, which would force EVERY file past the high aggregate numbers).
 *
 * So this runs as `posttest`: it reads coverage/coverage-summary.json (written
 * by the json-summary reporter) and fails if any included src file has 0% line
 * coverage and is not a documented, accepted gap below. It does NOT dictate a
 * per-file percentage — it only blocks the "imported but never tested" cliff.
 *
 * Fix a failure by adding a sibling test, not by extending KNOWN_GAPS.
 */

import { readFileSync } from "node:fs"
import { relative } from "node:path"

const SUMMARY_PATH = "coverage/coverage-summary.json"

/**
 * Accepted 0%-coverage files (debt as of the v0.4.204 line). Delete an entry
 * when its tests land. Do NOT add to this list to silence a new gap — the
 * whole point of the guard is to stop the list from growing silently.
 */
const KNOWN_GAPS: ReadonlySet<string> = new Set([
  "src/gha.ts",
  "src/fetchRepoMcp.ts",
  "src/submitMcp.ts",
  "src/scripts/goalCtx.ts",
  "src/scripts/previewBuildRun.ts",
])

type FileSummary = { lines?: { pct?: number } }

let raw: string
try {
  raw = readFileSync(SUMMARY_PATH, "utf8")
} catch {
  console.error(
    `[coverage-floor] ${SUMMARY_PATH} not found — run the coverage suite first (pnpm test). ` +
      `This guard runs as posttest; it expects the json-summary reporter to have written the file.`,
  )
  process.exit(1)
}

const summary = JSON.parse(raw) as Record<string, FileSummary>
const root = process.cwd()

const offenders: string[] = []
for (const [absPath, fileSummary] of Object.entries(summary)) {
  if (absPath === "total") continue
  const rel = relative(root, absPath).split("\\").join("/")
  if (KNOWN_GAPS.has(rel)) continue
  if ((fileSummary.lines?.pct ?? -1) === 0) offenders.push(rel)
}

if (offenders.length > 0) {
  offenders.sort()
  console.error(`\n[coverage-floor] FAIL: ${offenders.length} file(s) at 0% line coverage (wholly untested):`)
  for (const f of offenders) console.error(`    - ${f}`)
  console.error(
    `\n[coverage-floor] Add a sibling test for each. If a file is genuinely untestable, ` +
      `justify it in scripts/check-coverage-floor.ts KNOWN_GAPS — do not silence it casually.`,
  )
  process.exit(1)
}

const gapNote = KNOWN_GAPS.size > 0 ? ` (${KNOWN_GAPS.size} accepted gap(s) skipped)` : ""
console.log(`[coverage-floor] OK — no new 0%-coverage files${gapNote}.`)
