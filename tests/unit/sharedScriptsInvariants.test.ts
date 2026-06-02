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
  commitGoalState: { owner: "goal-tick", reason: "goal-tick is bespoke — see AGENTS.md goal-chain section." },
  deriveGoalPhase: { owner: "goal-tick", reason: "goal-tick state-machine step." },
  dispatchJobFileTicks: {
    owner: "job-scheduler",
    reason:
      "Solo since the worker model changed: a worker is now a stateless persona, not a ticked file, so worker-scheduler/worker-tick were deleted. job-scheduler is the only fan-out over .kody/jobs.",
  },
  loadJobFromFile: {
    owner: "job-tick",
    reason:
      "Solo since worker-tick was deleted (workers are personas, not ticked files). job-tick is the only executable that loads a job body + its assigned worker persona.",
  },
  parseJobStateFromAgentResult: {
    owner: "job-tick",
    reason: "Solo since worker-tick was deleted. job-tick is the only LLM-driven ticked-file executable.",
  },
  runTickScript: {
    owner: "job-tick-scripted",
    reason:
      "Solo since worker-tick-scripted was deleted (no worker tick-loop in the persona model). job-tick-scripted is the only deterministic ticked-file executable.",
  },
  dispatchNextTask: { owner: "goal-tick", reason: "goal-tick state-machine step." },
  finalizeGoal: { owner: "goal-tick", reason: "goal-tick terminal step." },
  handleAbandonedGoal: { owner: "goal-tick", reason: "goal-tick state-machine branch." },
  initFlow: { owner: "init", reason: "init is residual — bootstrap, not a recurring flow." },
  loadGoalState: { owner: "goal-tick", reason: "goal-tick state-machine step." },
  loadWorkerAdhoc: { owner: "worker-ask", reason: "worker-ask-only ad-hoc worker-persona loader." },
  markFlowSuccess: { owner: "revert", reason: "revert is bespoke (no-agent, see AGENTS.md)." },
  requirePlanDeviations: { owner: "run", reason: "run-only plan-deviation check." },
  resolveArtifacts: { owner: "run", reason: "run-only artifact resolver. Slotted via lifecycle contextExtras." },
  resolveFlow: { owner: "resolve", reason: "resolve is bespoke (merge-only, no verify chain — see AGENTS.md)." },
  revertFlow: { owner: "revert", reason: "revert is bespoke (no-agent)." },
  saveGoalState: { owner: "goal-tick", reason: "goal-tick state-machine step." },
  serveFlow: { owner: "serve", reason: "serve is bespoke (no-agent, long-lived local infra). Same shape as initFlow." },
  brainServe: {
    owner: "brain-serve",
    reason:
      "brain-serve is a long-lived HTTP server wrapping the chat loop for the Kody-Dashboard Brain proxy. Single-purpose; no other executable should share it.",
  },
  runnerServe: {
    owner: "runner-serve",
    reason:
      "runner-serve is a long-lived HTTP server for a warm-pool one-shot runner: it boots idle and runs one issue per claim over HTTP. Single-purpose; no other executable should share it.",
  },
  poolServe: {
    owner: "pool-serve",
    reason:
      "pool-serve is the always-on warm-pool owner: supervises LiteLLM and serves the dashboard's claim API. Single-purpose; no other executable should share it.",
  },
  stageMergeConflicts: { owner: "resolve", reason: "resolve-only postflight." },
  // ── Newly solo since the agent task executables (feature/bug/chore/plan/…)
  //    moved out of the engine to consumer repos. These were previously shared
  //    with the build-family executables via the lifecycle macro; with those
  //    gone, the named kept executable is now the only engine user. ──
  runFlow: {
    owner: "run",
    reason:
      "run bootstrap. Solo since feature/bug/chore collapsed/moved to consumer repos — run is the last engine build primitive.",
  },
  loadPriorArt: {
    owner: "run",
    reason: "run-only prior-art loader. Solo since the build executables moved out of the engine.",
  },
  verifyWithRetry: {
    owner: "run",
    reason: "run-only verify-with-retry gate. Solo since the build executables moved out of the engine.",
  },
  checkCoverageWithRetry: {
    owner: "run",
    reason: "run-only coverage gate. Solo since the build executables moved out of the engine.",
  },
  abortUnfinishedGitOps: {
    owner: "run",
    reason: "run-only git-ops guard. Solo since the build executables moved out of the engine.",
  },
  finalizeTerminal: {
    owner: "run",
    reason: "run-only terminal finalizer. Solo since the build executables moved out of the engine.",
  },
  mergeFlow: { owner: "merge", reason: "merge is bespoke (no-agent self-gating squash). Solo to merge." },
  syncFlow: { owner: "sync", reason: "sync is bespoke (no-agent fast-forward). Solo to sync." },
  finishFlow: { owner: "release", reason: "release finalize step. Solo to release." },
  promoteQaGoal: { owner: "qa-goal", reason: "qa-goal promotion step. Solo to qa-goal." },
  runPreviewBuild: {
    owner: "preview-build",
    reason:
      "preview-build is the only executable that builds a deployable preview image (remote builder). Single-purpose; no other executable shares the build step.",
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Consumer-library scripts: the deterministic preflight/postflight logic for
// the agent task executables that moved OUT of the engine into consumer repos
// (.kody/executables/<slug>/). The executable's profile.json + prompt.md now
// live in the consumer repo, but the engine still SHIPS these scripts — the
// consumer profiles reference them by name and the registry resolves them from
// the engine's compiled script catalog. So they have zero engine-side profile
// owner by design, yet must not be deleted.
//
// Each maps to the moved executable whose consumer-repo profile calls it.
// ─────────────────────────────────────────────────────────────────────────────
const CONSUMER_LIBRARY_SCRIPTS: Record<string, string> = {
  classifyByLabel: "classify",
  recordClassification: "classify",
  dispatchClassified: "classify",
  parseReproOutput: "reproduce",
  verifyReproFails: "reproduce",
  postPlanComment: "plan",
  postResearchComment: "research",
  diagMcp: "research",
  fixFlow: "fix",
  requireFeedbackActions: "fix",
  fixCiFlow: "fix-ci",
  resolvePreviewUrl: "ui-review",
  resolveQaUrl: "qa-engineer",
  warmupMcp: "qa-engineer",
  createQaGoal: "qa-engineer",
  startFlow: "spec",
  persistFlowState: "spec",
  dispatch: "spec",
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
    let profile: ReturnType<typeof loadProfile>
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

describe("consumer-library scripts (kept in engine, owned by moved executables)", () => {
  it("each consumer-library script still exists in src/scripts/ (moved executables call it by name)", () => {
    const missing: string[] = []
    for (const name of Object.keys(CONSUMER_LIBRARY_SCRIPTS)) {
      if (!fs.existsSync(path.join(SCRIPTS_DIR, `${name}.ts`))) {
        missing.push(
          `${name}: listed as consumer-library (for the moved "${CONSUMER_LIBRARY_SCRIPTS[name]}" executable) but src/scripts/${name}.ts is gone — consumer repos that copied that executable will break`,
        )
      }
    }
    expect(missing).toEqual([])
  })

  it("no consumer-library script is regained by an engine profile (would no longer be a consumer-only library)", () => {
    const usage = buildUsageMap()
    const regained: string[] = []
    for (const name of Object.keys(CONSUMER_LIBRARY_SCRIPTS)) {
      const owners = usage.get(name)
      if (owners && owners.size > 0) {
        regained.push(
          `${name}: now referenced by engine profile(s) ${[...owners].sort().join(", ")} — move it to KNOWN_SOLO_SCRIPTS instead of CONSUMER_LIBRARY_SCRIPTS`,
        )
      }
    }
    expect(regained).toEqual([])
  })

  it("a script is never in both the solo allowlist and the consumer library", () => {
    const dupes = Object.keys(CONSUMER_LIBRARY_SCRIPTS).filter((n) => KNOWN_SOLO_SCRIPTS[n])
    expect(dupes).toEqual([])
  })
})
