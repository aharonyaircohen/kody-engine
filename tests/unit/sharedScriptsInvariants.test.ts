/**
 * Architecture test — encodes the "shared scripts stay generic" invariant:
 *
 *   1. No file under src/scripts/ may compare profile.name as a branch
 *      condition (===, !==, ==, !=, switch, in/includes on literal name).
 *      Using profile.name as an opaque label (state keys, logs, producedBy
 *      tags, action-type prefixes) is allowed.
 *
 *   2. No file under src/scripts/ may import from src/executables/ —
 *      shared code cannot reach into executable-specific code, structurally
 *      preventing the per-executable branching pattern from ever creeping
 *      back in.
 *
 * When this test fails, the fix is to move the offending logic into the
 * specific executable's directory (see AGENTS.md § "clean executor layer").
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { loadProfile } from "../../src/profile.js"

const SCRIPTS_DIR = path.resolve(__dirname, "../../src/scripts")
const EXECUTABLES_DIR = path.resolve(__dirname, "../../src/executables")

function listScriptFiles(): string[] {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .map((f) => path.join(SCRIPTS_DIR, f))
}

function listExecutableNames(): string[] {
  return fs
    .readdirSync(EXECUTABLES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
}

describe("shared scripts: invariant — no executable-name branching", () => {
  it("does not compare profile.name as a branch condition", () => {
    const offenders: { file: string; line: number; text: string }[] = []
    // Matches: profile.name === / !== / == / != / switch(profile.name)
    const patterns = [/\bprofile(?:\?\.?|\.)name\s*[!=]==?/, /switch\s*\(\s*profile(?:\?\.?|\.)name\s*\)/]
    for (const file of listScriptFiles()) {
      const lines = fs.readFileSync(file, "utf-8").split("\n")
      lines.forEach((text, i) => {
        if (patterns.some((p) => p.test(text))) {
          offenders.push({ file: path.relative(SCRIPTS_DIR, file), line: i + 1, text: text.trim() })
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it("does not compare against literal executable names (catches aliased comparisons)", () => {
    // Catches the evade pattern: `const kind = profile.name; if (kind === "resolve")`.
    // Builds a regex from the actual executable names on disk, so the rule
    // stays accurate as executables are added/removed.
    const names = listExecutableNames()
    expect(names.length).toBeGreaterThan(0)
    const nameGroup = names.map((n) => n.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|")
    const pattern = new RegExp(`[!=]==?\\s*["'](?:${nameGroup})["']|case\\s+["'](?:${nameGroup})["']\\s*:`)
    const offenders: { file: string; line: number; text: string }[] = []
    for (const file of listScriptFiles()) {
      const lines = fs.readFileSync(file, "utf-8").split("\n")
      lines.forEach((text, i) => {
        if (pattern.test(text)) {
          offenders.push({ file: path.relative(SCRIPTS_DIR, file), line: i + 1, text: text.trim() })
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it("does not import from src/executables/", () => {
    const offenders: { file: string; line: number; text: string }[] = []
    // Matches any import/require path that resolves into ../executables/
    const pattern = /from\s+["'][^"']*\/executables\/[^"']+["']|require\(\s*["'][^"']*\/executables\/[^"']+["']/
    for (const file of listScriptFiles()) {
      const lines = fs.readFileSync(file, "utf-8").split("\n")
      lines.forEach((text, i) => {
        if (pattern.test(text)) {
          offenders.push({ file: path.relative(SCRIPTS_DIR, file), line: i + 1, text: text.trim() })
        }
      })
    }
    // Importing types from "../executables/types.js" is allowed — it's the
    // shared contract, not an implementation. Everything else is banned.
    const real = offenders.filter((o) => !/executables\/types(\.js)?["']/.test(o.text))
    expect(real).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Modularity invariant: src/scripts/ is for CROSS-CUTTING utilities. Single-
// executable scripts must be explicitly allowlisted as "known solo" until
// they're either generalised (referenced by ≥2 executables) or moved to an
// executable-local subdirectory. New solo scripts that sneak in without
// allowlisting fail this test loudly, surfacing the "shared utility" lie
// before it compounds.
//
// Owners of this allowlist: when removing the last reference to a solo
// script, also remove the entry here. When a solo script becomes referenced
// by ≥2 executables, also remove the entry (the script is now genuinely
// shared and no longer solo).
// ─────────────────────────────────────────────────────────────────────────────

interface SoloEntry {
  owner: string
  /**
   * Why this script is solo rather than promoted-and-shared OR moved out of
   * src/scripts/. Kept inline so reviewers see the rationale next to the
   * exception.
   */
  reason: string
}

const KNOWN_SOLO_SCRIPTS: Record<string, SoloEntry> = {
  classifyByLabel: { owner: "classify", reason: "Label-driven dispatch is a classify-only concern." },
  commitGoalState: { owner: "goal-tick", reason: "goal-tick is bespoke — see AGENTS.md goal-chain section." },
  createQaGoal: { owner: "qa-engineer", reason: "QA-only goal scaffolding." },
  deriveGoalPhase: { owner: "goal-tick", reason: "goal-tick state-machine step." },
  diagMcp: { owner: "research", reason: "MCP diagnostics specific to research mode." },
  dispatch: { owner: "spec", reason: "spec-only dispatch script." },
  dispatchClassified: { owner: "classify", reason: "Post-classification routing — classify-only." },
  dispatchJobFileTicks: { owner: "job-scheduler", reason: "Scheduler fan-out — only job-scheduler runs this." },
  dispatchNextTask: { owner: "goal-tick", reason: "goal-tick state-machine step." },
  finalizeGoal: { owner: "goal-tick", reason: "goal-tick terminal step." },
  fixCiFlow: { owner: "fix-ci", reason: "fix-ci bootstrap. Survives pr-branch migration; pending cross-executable extraction." },
  fixFlow: { owner: "fix", reason: "fix bootstrap. Survives pr-branch migration; pending cross-executable extraction." },
  handleAbandonedGoal: { owner: "goal-tick", reason: "goal-tick state-machine branch." },
  initFlow: { owner: "init", reason: "init is residual — bootstrap, not a recurring flow." },
  loadGoalState: { owner: "goal-tick", reason: "goal-tick state-machine step." },
  loadJobFromFile: { owner: "job-tick", reason: "job-tick file loader." },
  markFlowSuccess: { owner: "revert", reason: "revert is bespoke (no-agent, see AGENTS.md)." },
  parseJobStateFromAgentResult: { owner: "job-tick", reason: "job-tick result parser." },
  parseReproOutput: { owner: "reproduce", reason: "Reproduce-only output parser." },
  postPlanComment: { owner: "plan", reason: "plan-specific posting format." },
  postResearchComment: { owner: "research", reason: "research-specific posting format." },
  recordClassification: { owner: "classify", reason: "Classification-only persistence." },
  requireFeedbackActions: { owner: "fix", reason: "fix-only postflight assertion." },
  requirePlanDeviations: { owner: "run", reason: "run-only plan-deviation check." },
  resolveArtifacts: { owner: "run", reason: "run-only artifact resolver. Slotted via lifecycle contextExtras." },
  resolveFlow: { owner: "resolve", reason: "resolve is bespoke (merge-only, no verify chain — see AGENTS.md)." },
  resolvePreviewUrl: { owner: "ui-review", reason: "ui-review preview URL resolver." },
  resolveQaUrl: { owner: "qa-engineer", reason: "qa-engineer URL resolver." },
  revertFlow: { owner: "revert", reason: "revert is bespoke (no-agent)." },
  runTickScript: { owner: "job-tick-scripted", reason: "Scripted job-tick variant runner." },
  saveGoalState: { owner: "goal-tick", reason: "goal-tick state-machine step." },
  serveFlow: { owner: "serve", reason: "serve is bespoke (no-agent, long-lived local infra). Same shape as initFlow." },
  stageMergeConflicts: { owner: "resolve", reason: "resolve-only postflight." },
  startFlow: { owner: "spec", reason: "spec-only entry point." },
  verifyReproFails: { owner: "reproduce", reason: "Reproduce-only assertion." },
  warmupMcp: { owner: "qa-engineer", reason: "qa-engineer MCP warmup." },
}

function buildUsageMap(): Map<string, Set<string>> {
  // Counts EXPANDED references: a profile that opts into a lifecycle gets
  // credit for every script the lifecycle injects. This matches the
  // structural truth — a lifecycle-driven reference is still a reference
  // to that script from that profile, just expressed via a macro instead
  // of a literal entry. Without this, lifecycle migration would falsely
  // turn 3-executable shared scripts (syncFlow, loadMemoryContext, etc.)
  // into "solo" merely because their explicit profile references moved
  // into the lifecycle module.
  const usage = new Map<string, Set<string>>()
  for (const name of listExecutableNames()) {
    const profilePath = path.join(EXECUTABLES_DIR, name, "profile.json")
    if (!fs.existsSync(profilePath)) continue
    let profile
    try {
      profile = loadProfile(profilePath)
    } catch {
      continue
    }
    const all = [...profile.scripts.preflight, ...profile.scripts.postflight]
    for (const entry of all) {
      if (!entry.script) continue
      if (!usage.has(entry.script)) usage.set(entry.script, new Set())
      const set = usage.get(entry.script)
      if (set) set.add(profile.name)
    }
  }
  return usage
}

describe("script catalog: modularity invariant", () => {
  it("every script referenced by ≥2 executables is genuinely shared (not in solo allowlist)", () => {
    const usage = buildUsageMap()
    const wrongly_allowlisted: string[] = []
    for (const [name, owners] of usage) {
      if (owners.size >= 2 && KNOWN_SOLO_SCRIPTS[name]) {
        wrongly_allowlisted.push(
          `${name}: allowlisted as solo (owner: ${KNOWN_SOLO_SCRIPTS[name].owner}) but referenced by ${[...owners].sort().join(", ")} — remove from KNOWN_SOLO_SCRIPTS`,
        )
      }
    }
    expect(wrongly_allowlisted).toEqual([])
  })

  it("every solo-use script is in the allowlist (with reason)", () => {
    const usage = buildUsageMap()
    const unaccounted: string[] = []
    for (const [name, owners] of usage) {
      if (owners.size === 1 && !KNOWN_SOLO_SCRIPTS[name]) {
        const owner = [...owners][0]
        unaccounted.push(
          `${name} (used only by ${owner}) — add to KNOWN_SOLO_SCRIPTS with a reason, OR generalise so a second executable uses it`,
        )
      }
    }
    expect(unaccounted).toEqual([])
  })

  it("every allowlisted script is still referenced by its declared owner (stale entries fail)", () => {
    const usage = buildUsageMap()
    const stale: string[] = []
    for (const [name, entry] of Object.entries(KNOWN_SOLO_SCRIPTS)) {
      const owners = usage.get(name)
      if (!owners) {
        stale.push(`${name}: allowlisted but no profile references it — remove from KNOWN_SOLO_SCRIPTS`)
      } else if (!owners.has(entry.owner)) {
        stale.push(
          `${name}: allowlisted owner is "${entry.owner}" but actual owner(s) are ${[...owners].sort().join(", ")} — update KNOWN_SOLO_SCRIPTS`,
        )
      }
    }
    expect(stale).toEqual([])
  })
})
