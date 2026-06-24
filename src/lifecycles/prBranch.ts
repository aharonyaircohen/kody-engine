/**
 * `lifecycle: "pr-branch"` expander.
 *
 * Wraps the profile's `scripts.preflight` and `scripts.postflight` with the
 * canonical chain that PR-branch agentActions run.
 *
 * Layout (with all defaults — knobs documented below):
 *   preflight:
 *     [syncFlow]
 *     setLifecycleLabel{with: cfg.label}
 *     ...profile.scripts.preflight
 *     <context bundle: loadTaskState, [contextExtras...], loadConventions,
 *       loadPriorArt, loadMemoryContext, loadCoverageRules>
 *     composePrompt
 *
 *   postflight:
 *     parseAgentResult
 *     ...profile.scripts.postflight
 *     [verifyWithRetry, checkCoverageWithRetry, abortUnfinishedGitOps]
 *     commitAndPush
 *     ensurePr
 *     postIssueComment
 *     writeAgentRunSummary
 *     saveTaskState
 *     [mirrorStateToPr]
 *     [advanceFlow]
 *     [finalizeTerminal]
 *
 * Config (`profile.lifecycleConfig`):
 *   label:          { name, color, description }   (required)
 *   context:        "task" | "ci-fix" | "minimal"  (default "task")
 *   contextExtras:  string[]                       (optional, inserted after
 *                                                   loadTaskState inside the
 *                                                   context bundle; used by
 *                                                   `run` for resolveArtifacts)
 *   sync:           boolean                        (default true)
 *   verify:         boolean                        (default true)
 *   advance:        boolean                        (default true)
 *   mirrorState:    boolean                        (default false)
 *   finalize:       boolean                        (default false)
 *
 * Why these specific knobs (not a free-form config):
 * - `sync`: not all PR-branch agentActions fast-forward the local branch
 *   before working (run/resolve/revert don't).
 * - `verify`: merge-only operations (resolve) skip the quality-gate chain.
 * - `advance`: terminal stages (fix-ci, resolve, revert) don't re-trigger
 *   the orchestrator.
 * - `mirrorState`: only the issue-driven `run` mirrors task state into the
 *   PR body — fix and friends already have the PR.
 * - `finalize`: single-session agentActions (feature, bug — no orchestrator)
 *   stamp their own terminal kody:done/kody:failed label + phase. Container
 *   children leave it false; their orchestrator's finishFlow does it.
 * - `context`: pre-set bundles for task work (full) vs CI-fix (lean) vs
 *   minimal (declare-everything-manually).
 *
 * Anything more variant than this belongs in a different lifecycle.
 */

import type { Profile, ScriptEntry } from "../agent-actions/types.js"
import { ProfileError } from "../profile-error.js"

const VALID_CONTEXTS = new Set(["task", "ci-fix", "minimal"])

const CONTEXT_BUNDLES: Record<string, string[]> = {
  task: ["loadTaskState", "loadConventions", "loadPriorArt", "loadMemoryContext", "loadCoverageRules"],
  "ci-fix": ["loadTaskState", "loadConventions", "loadCoverageRules"],
  minimal: [],
}

interface PrBranchConfig {
  label: { name: string; color: string; description: string }
  context: "task" | "ci-fix" | "minimal"
  contextExtras: string[]
  sync: boolean
  verify: boolean
  advance: boolean
  mirrorState: boolean
  finalize: boolean
}

export function prBranchLifecycle(profile: Profile, profilePath: string): void {
  const cfg = validateConfig(profile.lifecycleConfig, profilePath)

  const before: ScriptEntry[] = []
  if (cfg.sync) before.push({ script: "syncFlow" })
  before.push({
    script: "setLifecycleLabel",
    with: {
      label: cfg.label.name,
      color: cfg.label.color,
      description: cfg.label.description,
    },
  })

  const contextBundle: ScriptEntry[] = buildContextBundle(cfg.context, cfg.contextExtras)
  const afterPreflight: ScriptEntry[] =
    cfg.context === "minimal" && cfg.contextExtras.length === 0
      ? [{ script: "composePrompt" }]
      : [...contextBundle, { script: "composePrompt" }]

  profile.scripts.preflight = [...before, ...profile.scripts.preflight, ...afterPreflight]

  const beforePostflight: ScriptEntry[] = [{ script: "parseAgentResult" }]

  const verifyChain: ScriptEntry[] = cfg.verify
    ? [{ script: "verifyWithRetry" }, { script: "checkCoverageWithRetry" }, { script: "abortUnfinishedGitOps" }]
    : []

  const tail: ScriptEntry[] = [
    ...verifyChain,
    { script: "commitAndPush" },
    { script: "ensurePr" },
    { script: "postIssueComment" },
    { script: "writeAgentRunSummary" },
    { script: "saveTaskState" },
  ]
  if (cfg.mirrorState) tail.push({ script: "mirrorStateToPr" })
  if (cfg.advance) tail.push({ script: "advanceFlow" })
  // Single-session agentActions (no orchestrator) stamp their own terminal
  // label + phase here, after the PR exists and state is saved. Always
  // last so it reads the authoritative post-saveTaskState state.
  if (cfg.finalize) tail.push({ script: "finalizeTerminal" })

  profile.scripts.postflight = [...beforePostflight, ...profile.scripts.postflight, ...tail]
}

function buildContextBundle(context: string, extras: string[]): ScriptEntry[] {
  const base = CONTEXT_BUNDLES[context] ?? []
  if (base.length === 0 && extras.length === 0) return []

  // Extras slot in after loadTaskState (or at the start if loadTaskState
  // isn't in this bundle). Lets `run` insert resolveArtifacts at the
  // legacy position without exploding the config surface area.
  const out: ScriptEntry[] = []
  let extrasInserted = false
  for (const name of base) {
    out.push({ script: name })
    if (name === "loadTaskState" && extras.length > 0) {
      for (const e of extras) out.push({ script: e })
      extrasInserted = true
    }
  }
  if (!extrasInserted && extras.length > 0) {
    out.unshift(...extras.map((e) => ({ script: e })))
  }
  return out
}

function validateConfig(raw: Record<string, unknown> | undefined, profilePath: string): PrBranchConfig {
  if (!raw) {
    throw new ProfileError(profilePath, `lifecycle "pr-branch" requires "lifecycleConfig" with a "label" object`)
  }

  const label = raw.label
  if (!label || typeof label !== "object" || Array.isArray(label)) {
    throw new ProfileError(profilePath, `lifecycle "pr-branch": lifecycleConfig.label must be an object`)
  }
  const lbl = label as Record<string, unknown>
  for (const k of ["name", "color", "description"]) {
    if (typeof lbl[k] !== "string" || (lbl[k] as string).length === 0) {
      throw new ProfileError(
        profilePath,
        `lifecycle "pr-branch": lifecycleConfig.label.${k} must be a non-empty string`,
      )
    }
  }

  const context = raw.context === undefined ? "task" : raw.context
  if (typeof context !== "string" || !VALID_CONTEXTS.has(context)) {
    throw new ProfileError(
      profilePath,
      `lifecycle "pr-branch": lifecycleConfig.context must be one of: ${[...VALID_CONTEXTS].join(" | ")}`,
    )
  }

  let contextExtras: string[] = []
  if (raw.contextExtras !== undefined) {
    if (!Array.isArray(raw.contextExtras) || raw.contextExtras.some((s) => typeof s !== "string" || !s)) {
      throw new ProfileError(
        profilePath,
        `lifecycle "pr-branch": lifecycleConfig.contextExtras must be an array of non-empty strings`,
      )
    }
    contextExtras = raw.contextExtras as string[]
  }

  return {
    label: {
      name: lbl.name as string,
      color: lbl.color as string,
      description: lbl.description as string,
    },
    context: context as "task" | "ci-fix" | "minimal",
    contextExtras,
    sync: parseBool(raw, profilePath, "sync", true),
    verify: parseBool(raw, profilePath, "verify", true),
    advance: parseBool(raw, profilePath, "advance", true),
    mirrorState: parseBool(raw, profilePath, "mirrorState", false),
    finalize: parseBool(raw, profilePath, "finalize", false),
  }
}

function parseBool(raw: Record<string, unknown>, profilePath: string, key: string, def: boolean): boolean {
  if (raw[key] === undefined) return def
  if (typeof raw[key] !== "boolean") {
    throw new ProfileError(profilePath, `lifecycle "pr-branch": lifecycleConfig.${key} must be a boolean`)
  }
  return raw[key] as boolean
}
