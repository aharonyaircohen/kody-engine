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
 *   - "job-scheduler" / "job-tick" — the retired `job-*` executable family,
 *                       renamed to `duty-scheduler` / `duty-tick`. The
 *                       `kody-job-next-state` fence label is a separate
 *                       concern (see parseJobStateFromAgentResult's alias
 *                       handling) and stays canonical, so it is NOT banned.
 *   - "dispatchJobFileTicks" / "dispatchJobTicks" — the retired dispatcher
 *                       script names, renamed to `dispatchDutyFileTicks` /
 *                       `dispatchDutyTicks`. The `Job` runtime envelope
 *                       (src/job.ts) is unaffected.
 *
 * NOT banned — "job" in general: the runtime envelope (`Job`, `JobFlavor`,
 * `Job` typed records), the `.kody/jobs/` engine scaffold path, the
 * `jobState`/`jobSlug`/`jobSchedule` ctx.data
 * fields (which the spec says MUST keep working alongside the new `duty*`
 * aliases), and the `kody-job-next-state` fence label all keep their `job`
 * names by Phase-1 design. The deadVocabulary test targets the specific
 * identifiers that have been renamed (`job-scheduler`, `job-tick`,
 * `dispatchJobFileTicks`, `dispatchJobTicks`), not the broader `job` token.
 *
 * Scope is src/ only (AGENTS.md is excluded because its naming note names the
 * banned terms on purpose to explain the ban). Tests may use these strings as
 * arbitrary fixtures.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const SRC_DIR = path.resolve(__dirname, "../../src")
const BANNED: Array<string | RegExp> = [
  "kody-manager",
  "mission-tick",
  "mission-scheduler",
  "job-scheduler",
  "job-tick",
  "dispatchJobFileTicks",
  "dispatchJobTicks",
  /\bstaff\b/,
  /\bStaff\b/,
  /\bpersona\b/,
  /\bPersona\b/,
  "worker-ask",
  "loadWorkerAdhoc",
]

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
      const found = typeof term === "string" ? text.includes(term) : term.test(text)
      if (found) {
        offenders.push(`${path.relative(SRC_DIR, file)} → "${String(term)}"`)
      }
    }
  }
    expect(offenders, `retired vocabulary found:\n${offenders.join("\n")}`).toEqual([])
  })
})
