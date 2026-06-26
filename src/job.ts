/**
 * Job — the unified execution unit (Phase 1: additive seam, no caller yet).
 *
 * `runJob` lowers a validated Job onto the existing executor
 * (`runExecutableChain`). This is the single entry point every trigger path
 * (comment, cron, manual) will funnel through in later phases. It deliberately
 * does NOT touch executor.ts — a Job maps to a (profileName, ExecutorInput) pair.
 *
 * Validation is hand-rolled: the project keeps runtime deps minimal (no zod)
 * and validates at boundaries the same way config.ts does.
 */

import * as path from "node:path"
import type { KodyConfig } from "./config.js"
import type { DispatchResult } from "./dispatch.js"
import type { Job, JobFlavor } from "./executables/types.js"
import type { ExecutorInput, ExecutorOutput } from "./executor.js"
import { runExecutable, runExecutableChain } from "./executor.js"
import { resolveCapabilityAction, resolveCapabilityFolder } from "./registry.js"

export { stableJobKey } from "./jobIdentity.js"

import { stableJobKey } from "./jobIdentity.js"

/** Default agent identity for instant `@kody` jobs (the agreed starting point). */
export const DEFAULT_INSTANT_AGENT = "kody"
let localJobSeq = 0

/**
 * Stable id for one run attempt, recorded under the task job. In GitHub Actions
 * the workflow run (id + attempt) is the natural attempt id; a local sequence
 * keeps multiple in-process child jobs distinct inside the same workflow run.
 * Off-CI, fall back to a flavor + timestamp stamp plus the same counter.
 */
export function newJobId(flavor: JobFlavor): string {
  localJobSeq += 1
  const runId = process.env.GITHUB_RUN_ID
  if (runId) return `gh-${runId}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}-${localJobSeq}`
  return `${flavor}-${Date.now()}-${localJobSeq}`
}

/** Thrown when a minted Job fails boundary validation. */
export class InvalidJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidJobError"
  }
}

/**
 * Validate a minted Job at the boundary. A Job must name a capability/action, a
 * known `flavor`, and (if present) an object `cliArgs`. `executable` is only
 * an implementation selected under that capability; it is never valid by itself.
 * `why` is untrusted free text and is NOT content-checked here — fencing
 * happens where it enters a prompt.
 */
export function validateJob(input: unknown): Job {
  if (!input || typeof input !== "object") {
    throw new InvalidJobError("job must be an object")
  }
  const j = input as Record<string, unknown>
  if (typeof j.capability !== "string" && typeof j.action !== "string") {
    throw new InvalidJobError("job must reference a capability action or capability")
  }
  if (j.flavor !== "instant" && j.flavor !== "scheduled") {
    throw new InvalidJobError(`job.flavor must be "instant" or "scheduled" (got ${String(j.flavor)})`)
  }
  if (j.cliArgs !== undefined && (typeof j.cliArgs !== "object" || j.cliArgs === null)) {
    throw new InvalidJobError("job.cliArgs must be an object when present")
  }
  return {
    action: typeof j.action === "string" ? j.action : undefined,
    executable: typeof j.executable === "string" ? j.executable : undefined,
    capability: typeof j.capability === "string" ? j.capability : undefined,
    why: typeof j.why === "string" ? j.why : undefined,
    agent: typeof j.agent === "string" ? j.agent : undefined,
    schedule: typeof j.schedule === "string" ? j.schedule : undefined,
    target: typeof j.target === "number" ? j.target : undefined,
    cliArgs: (j.cliArgs as Record<string, unknown> | undefined) ?? {},
    flavor: j.flavor,
    force: j.force === true,
    saveReport: j.saveReport === true,
  }
}

/** Ambient inputs the executor needs that don't belong to the Job itself. */
export interface RunJobBase {
  cwd: string
  config?: KodyConfig
  skipConfig?: boolean
  verbose?: boolean
  quiet?: boolean
  preloadedData?: Record<string, unknown>
  /**
   * Follow in-process stage hand-offs (`runExecutableChain`) by default,
   * matching the comment/manual route. Scheduled watch fan-out can set `false`
   * for one-shot ticks that must not follow a returned nextDispatch.
   */
  chain?: boolean
}

/**
 * Execute a Job by lowering it onto the existing executor.
 *
 * Mapping:
 *   - capability/action resolves first             (the public capability contract)
 *   - profile = job.executable ?? capability.executable (the implementation)
 *   - cliArgs = job.cliArgs                   (target already bound by the minter)
 *   - capability/executable → preloadedData          (seeded so the executor can
 *                                              expose the job references to
 *                                              the model generically)
 *   - inline why → preloadedData.jobWhy        (seeded into ctx.data before
 *                                              preflights; the executor injects
 *                                              it as a fenced operator-request
 *                                              block in the system prompt)
 *   - agent  → preloadedData.jobAgent
 *
 * No caller mints Jobs yet — this is the seam later phases wire the comment and
 * cron paths into.
 */
export async function runJob(job: Job, base: RunJobBase): Promise<ExecutorOutput> {
  const valid = validateJob(job)
  const action = valid.action ?? valid.capability
  const projectCapabilitiesRoot = path.join(base.cwd, ".kody", "capabilities")
  const resolvedCapability = action ? resolveCapabilityAction(action, projectCapabilitiesRoot) : null
  const capabilityIdentity = valid.capability ?? resolvedCapability?.capability
  const capabilityContext = loadCapabilityContext(capabilityIdentity, base.cwd)
  const explicitExecutableOnly =
    valid.executable !== undefined &&
    (valid.action === undefined || valid.action === valid.executable) &&
    (valid.capability === undefined || valid.capability === valid.executable)
  if (!resolvedCapability && !capabilityContext && !explicitExecutableOnly) {
    throw new InvalidJobError(`job capability not found: ${action ?? valid.capability ?? "<none>"}`)
  }
  const capabilitySelectedExecutable =
    resolvedCapability?.executable ??
    capabilityContext?.config.executable ??
    capabilityContext?.config.executables?.[0] ??
    (capabilityContext?.config.tickScript ? "capability-tick-scripted" : undefined)
  const profileName = valid.executable ?? capabilitySelectedExecutable
  if (!profileName) {
    throw new InvalidJobError(`job capability resolves to no executable: ${capabilityIdentity ?? action}`)
  }

  const preloadedData: Record<string, unknown> = { ...(base.preloadedData ?? {}) }
  // Stamp both identities: jobKey is stable required work on the task; jobId is
  // this execution attempt.
  preloadedData.jobId = newJobId(valid.flavor)
  preloadedData.jobKey = stableJobKey(valid)
  preloadedData.jobFlavor = valid.flavor
  if (valid.target !== undefined) preloadedData.jobTarget = valid.target
  if (valid.action !== undefined && valid.action.length > 0) preloadedData.jobAction = valid.action
  if (capabilityIdentity !== undefined && capabilityIdentity.length > 0)
    preloadedData.jobCapability = capabilityIdentity
  const executableIdentity = profileName
  if (executableIdentity !== undefined && executableIdentity.length > 0)
    preloadedData.jobExecutable = executableIdentity
  // The job carries *when*: a scheduled job's cadence, recorded in the ledger.
  if (valid.schedule !== undefined && valid.schedule.length > 0) preloadedData.jobSchedule = valid.schedule
  if (valid.saveReport === true) preloadedData.jobSaveReport = true
  if (capabilityContext) {
    preloadedData.capabilitySlug = capabilityContext.slug
    preloadedData.capabilityTitle = capabilityContext.title
    preloadedData.dutyIntent = capabilityContext.body
    preloadedData.jobIntent = capabilityContext.body
    if (preloadedData.jobCapability === undefined) preloadedData.jobCapability = capabilityContext.slug
    if (capabilityContext.config.agent && preloadedData.jobAgent === undefined) {
      preloadedData.jobAgent = capabilityContext.config.agent
    }
    if (capabilityContext.config.mentions && capabilityContext.config.mentions.length > 0) {
      preloadedData.mentions = capabilityContext.config.mentions.map((login: string) => `@${login}`).join(" ")
    }
  }
  // Inline why → ctx.data.jobWhy (NOT jobIntent — that token is the scheduled
  // capability BODY, consumed via {{jobIntent}} by capability-tick; reusing it would
  // double-inject). The executor surfaces jobWhy to the agent as a fenced
  // "operator request" block, so the comment's wording shapes any instant run.
  if (valid.why !== undefined && valid.why.length > 0) preloadedData.jobWhy = valid.why
  if (valid.agent !== undefined) preloadedData.jobAgent = valid.agent

  const input: ExecutorInput = {
    cliArgs: { ...valid.cliArgs },
    cwd: base.cwd,
    config: base.config,
    skipConfig: base.skipConfig,
    verbose: base.verbose,
    quiet: base.quiet,
    preloadedData: Object.keys(preloadedData).length > 0 ? preloadedData : undefined,
  }
  const shouldApplyResolvedCapabilityArgs =
    valid.executable === undefined && resolvedCapability && profileName === resolvedCapability.executable
  input.cliArgs = shouldApplyResolvedCapabilityArgs
    ? { ...resolvedCapability.cliArgs, ...input.cliArgs }
    : input.cliArgs

  const run = base.chain === false ? runExecutable : runExecutableChain
  return run(profileName, input)
}

function loadCapabilityContext(slug: string | undefined, cwd: string): ReturnType<typeof resolveCapabilityFolder> {
  if (!slug) return null
  return resolveCapabilityFolder(slug, path.join(cwd, ".kody", "capabilities"))
}

// ────────────────────────────────────────────────────────────────────────────
// Minters (phase 2): event → Job. Pure mappers, no caller yet — the comment
// and cron paths funnel through these in a later phase, then `runJob` runs the
// result.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mint an INSTANT job from a comment / manual-dispatch route. The trigger
 * resolves to a DispatchResult (executable + cliArgs + target); this turns it
 * into a Job. `why` is the operator's free-text request after `@kody <command>`
 * (carried on the DispatchResult); `agent` defaults to "kody" — instant verbs
 * ran agent-less before, and the default is the agreed starting point.
 * Both are overridable per call via `opts`.
 */
export function mintInstantJob(dispatch: DispatchResult, opts?: { why?: string; agent?: string }): Job {
  return {
    action: dispatch.action,
    executable: dispatch.executable,
    capability: dispatch.capability,
    why: opts?.why ?? dispatch.why,
    agent: opts?.agent ?? DEFAULT_INSTANT_AGENT,
    target: dispatch.target,
    cliArgs: dispatch.cliArgs,
    flavor: "instant",
  }
}

/** Inputs the cron tick path resolves per due capability slug. */
export interface ScheduledJobInput {
  /** Public action for this scheduled capability, when distinct from the slug. */
  action?: string
  /** The capability slug (its capability contract body lives in `.kody/capabilities/<slug>/capability.md`). */
  capability: string
  /** The executable that ticks it (capability-tick / capability-tick-scripted, or a folder-capability slug). */
  executable: string
  /** Cron cadence the capability fired on. */
  schedule?: string
  /** Agent identity that runs it (from the capability's profile.json). */
  agent?: string
  /** Args handed to the tick executable (e.g. `{ job: slug }` for `.md` capabilities). */
  cliArgs?: Record<string, unknown>
  /** Ask the owning goal/loop to refresh reports/<goal-or-loop>.md after its persisted decision. */
  saveReport?: boolean
}

/**
 * Mint a SCHEDULED job from a due capability slug. The cron path enumerates due
 * capabilities; each becomes a scheduled Job whose `executable` is the ticker and
 * whose `capability` carries the intent. No caller yet — wired in a later phase.
 */
export function mintScheduledJob(input: ScheduledJobInput): Job {
  return {
    action: input.action,
    capability: input.capability,
    executable: input.executable,
    schedule: input.schedule,
    agent: input.agent,
    cliArgs: input.cliArgs ?? {},
    flavor: "scheduled",
    saveReport: input.saveReport === true,
  }
}
