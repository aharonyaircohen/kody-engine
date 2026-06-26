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
import type { CapabilityFolder, CapabilityWorkflowConfig, CapabilityWorkflowStepConfig } from "./capabilityFolders.js"
import type { KodyConfig } from "./config.js"
import type { DispatchResult } from "./dispatch.js"
import type { Job, JobFlavor } from "./executables/types.js"
import type { ExecutorInput, ExecutorOutput } from "./executor.js"
import { runExecutable, runExecutableChain } from "./executor.js"
import {
  type DiscoveredCapabilityAction,
  getCapabilityActionInputs,
  resolveCapabilityAction,
  resolveCapabilityFolder,
} from "./registry.js"
import type { Action } from "./state.js"
import {
  isWorkflowDefinitionId,
  readWorkflowDefinition,
  workflowDefinitionToCapabilityFolder,
} from "./workflowDefinitions.js"

export { stableJobKey } from "./jobIdentity.js"

import { stableJobKey, targetFromCliArgs } from "./jobIdentity.js"

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
  if (typeof j.capability !== "string" && typeof j.action !== "string" && typeof j.workflow !== "string") {
    throw new InvalidJobError("job must reference a capability action, capability, or workflow")
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
    workflow: typeof j.workflow === "string" ? j.workflow : undefined,
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
  const resolvedCapability = !valid.workflow && action ? resolveCapabilityAction(action, projectCapabilitiesRoot) : null
  const capabilityIdentity = valid.capability ?? resolvedCapability?.capability
  const capabilityContext = valid.workflow ? null : loadCapabilityContext(capabilityIdentity, base.cwd)
  const workflowContext = valid.workflow
    ? loadWorkflowContext(valid.workflow, base)
    : !capabilityContext && !resolvedCapability
      ? loadWorkflowContext(capabilityIdentity ?? action, base)
      : null
  const explicitExecutableOnly =
    valid.executable !== undefined &&
    (valid.action === undefined || valid.action === valid.executable) &&
    (valid.capability === undefined || valid.capability === valid.executable)
  if (!resolvedCapability && !capabilityContext && !workflowContext && !explicitExecutableOnly) {
    throw new InvalidJobError(
      `job capability/workflow not found: ${valid.workflow ?? action ?? valid.capability ?? "<none>"}`,
    )
  }

  const workflow = capabilityContext?.config.workflow ?? workflowContext?.config.workflow
  const workflowIdentity = valid.workflow ?? capabilityIdentity ?? workflowContext?.slug
  const capabilitySelectedExecutable =
    resolvedCapability?.executable ??
    capabilityContext?.config.executable ??
    capabilityContext?.config.executables?.[0] ??
    (capabilityContext?.config.tickScript ? "capability-tick-scripted" : undefined)
  const profileName = valid.executable ?? capabilitySelectedExecutable
  if (workflow && shouldRunCapabilityWorkflow(valid, workflow, workflowIdentity, capabilitySelectedExecutable, base)) {
    const workflowCapability = capabilityContext ?? workflowContext!
    const workflowJob = workflowContext && !valid.why ? { ...valid, why: workflowContext.body } : valid
    return runCapabilityWorkflow(workflowJob, workflow, workflowCapability, base)
  }

  if (!profileName) {
    throw new InvalidJobError(`job capability resolves to no executable: ${capabilityIdentity ?? action}`)
  }

  return runDefaultCapabilityWorkflow(
    valid,
    profileName,
    capabilityIdentity,
    capabilityContext,
    resolvedCapability,
    base,
  )
}

async function runDefaultCapabilityWorkflow(
  job: Job,
  profileName: string,
  capabilityIdentity: string | undefined,
  capabilityContext: CapabilityFolder | null,
  resolvedCapability: DiscoveredCapabilityAction | null,
  base: RunJobBase,
): Promise<ExecutorOutput> {
  return runCapabilityImplementationStep(
    job,
    profileName,
    capabilityIdentity,
    capabilityContext,
    resolvedCapability,
    base,
  )
}

async function runCapabilityImplementationStep(
  valid: Job,
  profileName: string,
  capabilityIdentity: string | undefined,
  capabilityContext: CapabilityFolder | null,
  resolvedCapability: DiscoveredCapabilityAction | null,
  base: RunJobBase,
): Promise<ExecutorOutput> {
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
  preloadedData.jobExecutable = profileName
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

function shouldRunCapabilityWorkflow(
  job: Job,
  workflow: CapabilityWorkflowConfig,
  capabilityIdentity: string | undefined,
  selectedExecutable: string | undefined,
  base: RunJobBase,
): boolean {
  if (workflow.steps.length === 0) return false
  if (!capabilityIdentity) return false
  const stack = Array.isArray(base.preloadedData?.workflowStack)
    ? (base.preloadedData.workflowStack as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : []
  if (stack.includes(capabilityIdentity)) return false
  if (!job.executable) return true
  return job.executable === selectedExecutable || job.executable === capabilityIdentity || job.executable === job.action
}

async function runCapabilityWorkflow(
  parent: Job,
  workflow: CapabilityWorkflowConfig,
  capability: CapabilityFolder,
  base: RunJobBase,
): Promise<ExecutorOutput> {
  let chainData: Record<string, unknown> = {
    ...(base.preloadedData ?? {}),
    workflowCapability: capability.slug,
    workflowTitle: capability.title,
    workflowStepCount: workflow.steps.length,
    workflowIssueNumber: workflowIssueNumber(parent),
    workflowStack: [
      ...(Array.isArray(base.preloadedData?.workflowStack)
        ? (base.preloadedData.workflowStack as unknown[]).filter((entry): entry is string => typeof entry === "string")
        : []),
      capability.slug,
    ],
  }
  let result: ExecutorOutput = { exitCode: 0 }

  for (let index = 0; index < workflow.steps.length; index++) {
    const step = workflow.steps[index]!
    const label = step.action ?? step.capability
    if (!shouldRunWorkflowStep(step, chainData)) {
      process.stdout.write(
        `→ kody: workflow ${capability.slug} step ${index + 1}/${workflow.steps.length} → ${label} (skipped)\n\n`,
      )
      continue
    }
    const child = workflowStepToJob(step, parent, chainData)
    process.stdout.write(
      `→ kody: workflow ${capability.slug} step ${index + 1}/${workflow.steps.length} → ${label}\n\n`,
    )
    result = await runJob(child, {
      ...base,
      preloadedData: {
        ...chainData,
        workflowStep: label,
        workflowStepIndex: index + 1,
        workflowStepReason: step.reason,
      },
    })
    const outcome = workflowOutcome(result)
    const prUrl =
      result.taskState?.core.prUrl ??
      (typeof chainData.workflowPrUrl === "string" ? chainData.workflowPrUrl : undefined)
    chainData = {
      ...chainData,
      ...(result.taskState ? { taskState: result.taskState } : {}),
      ...(outcome ? { workflowLastOutcome: outcome } : {}),
      ...(prUrl ? { workflowPrUrl: prUrl } : {}),
      ...(parsePrNumber(prUrl) ? { workflowPrNumber: parsePrNumber(prUrl) } : {}),
    }
    if (result.exitCode !== 0 && !canContinueWorkflow(step, outcome)) {
      return {
        ...result,
        reason:
          result.reason ??
          `workflow ${capability.slug} stopped at step ${index + 1}/${workflow.steps.length}: ${label}`,
      }
    }
  }

  return result
}

function workflowStepToJob(step: CapabilityWorkflowStepConfig, parent: Job, chainData: Record<string, unknown>): Job {
  const action = step.action ?? step.capability
  const rawArgs = {
    ...parent.cliArgs,
    ...(step.cliArgs ?? {}),
  }
  const targetNumber = workflowStepTargetNumber(step, parent, chainData)
  if (step.target === "pr") {
    if (typeof targetNumber !== "number") {
      throw new InvalidJobError(`workflow step ${action} needs a PR target but no prior PR URL is available`)
    }
    rawArgs.pr = targetNumber
  } else if (step.target === "issue" && typeof targetNumber === "number") {
    rawArgs.issue = targetNumber
  }
  const cliArgs = filterCliArgsForStep(action, rawArgs)
  const target =
    typeof targetNumber === "number"
      ? targetNumber
      : typeof parent.target === "number"
        ? parent.target
        : targetFromCliArgs(cliArgs)
  return {
    action,
    capability: step.capability,
    ...(step.executable ? { executable: step.executable } : {}),
    ...(composeStepWhy(parent.why, step) ? { why: composeStepWhy(parent.why, step) } : {}),
    ...((step.agent ?? parent.agent) ? { agent: step.agent ?? parent.agent } : {}),
    ...(parent.schedule ? { schedule: parent.schedule } : {}),
    ...(typeof target === "number" ? { target } : {}),
    cliArgs,
    flavor: parent.flavor,
    force: parent.force,
    saveReport: step.saveReport === true || parent.saveReport === true,
  }
}

function shouldRunWorkflowStep(step: CapabilityWorkflowStepConfig, data: Record<string, unknown>): boolean {
  if (!step.runWhen) return true
  const context = workflowConditionContext(data)
  return Object.entries(step.runWhen).every(([path, expected]) =>
    valueMatches(resolveDottedPath(context, path), expected),
  )
}

function canContinueWorkflow(step: CapabilityWorkflowStepConfig, outcome: Action | null): boolean {
  if (!outcome || !step.continueOn || step.continueOn.length === 0) return false
  return step.continueOn.includes(outcome.type)
}

function workflowOutcome(result: ExecutorOutput): Action | null {
  return result.taskState?.core.lastOutcome ?? null
}

function workflowConditionContext(data: Record<string, unknown>): Record<string, unknown> {
  const lastOutcome = data.workflowLastOutcome
  return {
    ...data,
    workflow: {
      lastOutcome,
      issueNumber: data.workflowIssueNumber,
      prNumber: data.workflowPrNumber,
      prUrl: data.workflowPrUrl,
    },
    lastOutcome,
  }
}

function resolveDottedPath(root: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((cur, part) => {
    if (!cur || typeof cur !== "object") return undefined
    return (cur as Record<string, unknown>)[part]
  }, root)
}

function valueMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((entry) => valueMatches(actual, entry))
  return actual === expected
}

function workflowStepTargetNumber(
  step: CapabilityWorkflowStepConfig,
  parent: Job,
  chainData: Record<string, unknown>,
): number | undefined {
  if (step.target === "pr") return workflowPrNumber(chainData) ?? targetFromCliArgs(step.cliArgs ?? {})
  if (step.target === "issue") return workflowIssueNumber(parent)
  return typeof parent.target === "number"
    ? parent.target
    : targetFromCliArgs({ ...parent.cliArgs, ...(step.cliArgs ?? {}) })
}

function workflowIssueNumber(parent: Job): number | undefined {
  return typeof parent.target === "number" ? parent.target : targetFromCliArgs(parent.cliArgs)
}

function workflowPrNumber(data: Record<string, unknown>): number | undefined {
  if (typeof data.workflowPrNumber === "number" && Number.isFinite(data.workflowPrNumber)) return data.workflowPrNumber
  const prUrl =
    typeof data.workflowPrUrl === "string"
      ? data.workflowPrUrl
      : typeof (data.taskState as { core?: { prUrl?: unknown } } | undefined)?.core?.prUrl === "string"
        ? (data.taskState as { core: { prUrl: string } }).core.prUrl
        : undefined
  return parsePrNumber(prUrl) ?? undefined
}

function parsePrNumber(url: string | undefined): number | null {
  if (!url) return null
  const m = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : null
}

function filterCliArgsForStep(action: string, raw: Record<string, unknown>): Record<string, unknown> {
  const inputs = getCapabilityActionInputs(action)
  if (!inputs) return raw
  const allowed = new Set<string>(["_", "cwd", "verbose", "quiet"])
  for (const input of inputs) {
    const flagKey = input.flag.replace(/^--/, "")
    allowed.add(input.name)
    allowed.add(flagKey)
    if (flagKey.includes("-")) allowed.add(flagKey.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()))
  }
  return Object.fromEntries(Object.entries(raw).filter(([key]) => allowed.has(key)))
}

function composeStepWhy(parentWhy: string | undefined, step: CapabilityWorkflowStepConfig): string {
  return [parentWhy?.trim(), step.reason ? `Workflow step: ${step.reason}` : ""]
    .filter((part): part is string => Boolean(part))
    .join("\n\n")
}

function loadCapabilityContext(slug: string | undefined, cwd: string): ReturnType<typeof resolveCapabilityFolder> {
  if (!slug) return null
  return resolveCapabilityFolder(slug, path.join(cwd, ".kody", "capabilities"))
}

function loadWorkflowContext(slug: string | undefined, base: RunJobBase): CapabilityFolder | null {
  if (!slug || !base.config || !isWorkflowDefinitionId(slug)) return null
  const workflow = readWorkflowDefinition(base.config, base.cwd, slug)
  return workflow ? workflowDefinitionToCapabilityFolder(slug, workflow) : null
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
