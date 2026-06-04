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

import type { KodyConfig } from "./config.js"
import type { Job } from "./executables/types.js"
import { runExecutableChain } from "./executor.js"
import type { ExecutorInput, ExecutorOutput } from "./executor.js"

/** Thrown when a minted Job fails boundary validation. */
export class InvalidJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidJobError"
  }
}

/**
 * Validate a minted Job at the boundary. A Job must name at least one of
 * `executable` or `duty` (something to run), a known `flavor`, and (if present)
 * an object `cliArgs`. `why` is untrusted free text and is NOT content-checked
 * here — fencing happens where it enters a prompt.
 */
export function validateJob(input: unknown): Job {
  if (!input || typeof input !== "object") {
    throw new InvalidJobError("job must be an object")
  }
  const j = input as Record<string, unknown>
  if (typeof j.executable !== "string" && typeof j.duty !== "string") {
    throw new InvalidJobError("job must reference an executable or a duty")
  }
  if (j.flavor !== "instant" && j.flavor !== "scheduled") {
    throw new InvalidJobError(`job.flavor must be "instant" or "scheduled" (got ${String(j.flavor)})`)
  }
  if (j.cliArgs !== undefined && (typeof j.cliArgs !== "object" || j.cliArgs === null)) {
    throw new InvalidJobError("job.cliArgs must be an object when present")
  }
  return {
    executable: typeof j.executable === "string" ? j.executable : undefined,
    duty: typeof j.duty === "string" ? j.duty : undefined,
    why: typeof j.why === "string" ? j.why : undefined,
    persona: typeof j.persona === "string" ? j.persona : undefined,
    schedule: typeof j.schedule === "string" ? j.schedule : undefined,
    target: typeof j.target === "number" ? j.target : undefined,
    cliArgs: (j.cliArgs as Record<string, unknown> | undefined) ?? {},
    flavor: j.flavor,
    force: j.force === true,
  }
}

/** Ambient inputs the executor needs that don't belong to the Job itself. */
export interface RunJobBase {
  cwd: string
  config?: KodyConfig
  verbose?: boolean
  quiet?: boolean
}

/**
 * Execute a Job by lowering it onto the existing executor.
 *
 * Mapping:
 *   - profile = job.executable ?? job.duty   (the runner / "how")
 *   - cliArgs = job.cliArgs                   (target already bound by the minter)
 *   - inline why → preloadedData.jobIntent    (seeded into ctx.data before
 *                                              preflights; the prompt layer
 *                                              consumes it in a later phase)
 *   - persona  → preloadedData.jobPersona
 *
 * No caller mints Jobs yet — this is the seam later phases wire the comment and
 * cron paths into.
 */
export async function runJob(job: Job, base: RunJobBase): Promise<ExecutorOutput> {
  const valid = validateJob(job)
  const profileName = valid.executable ?? valid.duty
  if (!profileName) {
    throw new InvalidJobError("job resolves to no executable or duty")
  }

  const preloadedData: Record<string, unknown> = {}
  if (valid.why !== undefined) preloadedData.jobIntent = valid.why
  if (valid.persona !== undefined) preloadedData.jobPersona = valid.persona

  const input: ExecutorInput = {
    cliArgs: { ...valid.cliArgs },
    cwd: base.cwd,
    config: base.config,
    verbose: base.verbose,
    quiet: base.quiet,
    preloadedData: Object.keys(preloadedData).length > 0 ? preloadedData : undefined,
  }

  return runExecutableChain(profileName, input)
}
