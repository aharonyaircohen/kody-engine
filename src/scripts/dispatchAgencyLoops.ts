import { createLoopState, type LoopDefinition, type LoopState } from "@kody-ade/agency-domain"
import type { KodyConfig } from "../config.js"
import { AgencyModelRepository } from "../goal/agencyModelRepository.js"
import { decideTrigger } from "../goal/triggerDispatcher.js"
import type { Job, PreflightScript } from "../implementations/types.js"
import { runJob } from "../job.js"
import { createStateBackendFromEnv, type StateBackend } from "../state-backend.js"

interface DispatchResult {
  loopId: string
  decision: "skipped" | "duplicate" | "dispatched" | "failed"
  reason: string
}

export const dispatchAgencyLoops: PreflightScript = async (ctx) => {
  const tenantId = repositoryTenant(ctx.config)
  if (!tenantId) throw new Error("Repository identity is required for Agency Loop dispatch")
  const backend = createStateBackendFromEnv()
  const results = await dispatchAgencyLoopsWith({
    tenantId,
    backend,
    now: new Date(),
    run: (job) => runJob(job, { cwd: ctx.cwd, config: ctx.config, verbose: ctx.verbose, quiet: ctx.quiet, chain: false }),
  })
  ctx.data.agencyLoopDispatchResults = results
}

export async function dispatchAgencyLoopsWith(input: {
  tenantId: string
  backend: StateBackend
  now: Date
  run: (job: Job) => Promise<{ exitCode: number; reason?: string; data?: Record<string, unknown> }>
}): Promise<DispatchResult[]> {
  const repository = new AgencyModelRepository(input.backend, input.tenantId)
  const records = await repository.listManagedWork()
  const loops = records.filter(
    (record): record is { definition: LoopDefinition; state: LoopState | null } => "trigger" in record.definition,
  )
  const results: DispatchResult[] = []

  for (const record of loops) {
    const decision = decideTrigger({ definition: record.definition, state: record.state, now: input.now })
    const now = input.now.toISOString()
    if (decision.kind === "skip") {
      const key = `${record.definition.id}:skip:${now}`
      await input.backend.recordSkippedAgencyDispatch(input.tenantId, key, record.definition.id, decision, now)
      if (record.state && decision.nextEligibleAt) {
        await repository.saveState(
          createLoopState({ ...record.state, nextEligibleAt: decision.nextEligibleAt, updatedAt: now }),
          "loop",
          now,
        )
      }
      results.push({ loopId: record.definition.id, decision: "skipped", reason: decision.reason })
      continue
    }

    const leaseUntil = new Date(input.now.getTime() + 15 * 60_000).toISOString()
    const reservation = await input.backend.reserveAgencyDispatch(
      input.tenantId,
      decision.idempotencyKey,
      record.definition.id,
      decision,
      leaseUntil,
      now,
    )
    if (!reservation.acquired) {
      results.push({ loopId: record.definition.id, decision: "duplicate", reason: "trigger firing already reserved" })
      continue
    }

    const runningState = createLoopState({
      definitionId: record.definition.id,
      lifecycle: record.state?.lifecycle ?? "active",
      health: record.state?.health ?? "unknown",
      failures: record.state?.failures ?? 0,
      lastFiredAt: decision.scheduledAt,
      updatedAt: now,
    })
    await repository.saveState(runningState, "loop", now)

    try {
      const output = await input.run(jobForTarget(record.definition))
      const succeeded = output.exitCode === 0
      await input.backend.finishAgencyDispatch(
        input.tenantId,
        decision.idempotencyKey,
        succeeded ? "dispatched" : "failed",
        new Date().toISOString(),
      )
      await repository.saveState(
        createLoopState({
          ...runningState,
          health: succeeded ? "healthy" : "degraded",
          failures: succeeded ? 0 : runningState.failures + 1,
          updatedAt: new Date().toISOString(),
        }),
        "loop",
        new Date().toISOString(),
      )
      results.push({
        loopId: record.definition.id,
        decision: succeeded ? "dispatched" : "failed",
        reason: output.reason ?? (succeeded ? "target dispatched" : "target failed"),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await input.backend.finishAgencyDispatch(input.tenantId, decision.idempotencyKey, "failed", new Date().toISOString())
      results.push({ loopId: record.definition.id, decision: "failed", reason })
    }
  }
  return results
}

function jobForTarget(loop: LoopDefinition): Job {
  if (loop.targetRef.kind === "workflow") {
    return { workflow: loop.targetRef.id, cliArgs: {}, flavor: "scheduled" }
  }
  if (loop.targetRef.kind === "capability") {
    return { capability: loop.targetRef.id, cliArgs: {}, flavor: "scheduled" }
  }
  return {
    capability: "goal-manager",
    implementation: "goal-manager",
    cliArgs: { goal: loop.targetRef.id },
    flavor: "scheduled",
  }
}

function repositoryTenant(config: KodyConfig): string | null {
  const owner = config.github?.owner?.trim() || process.env.GITHUB_REPOSITORY?.split("/")[0]?.trim()
  const repo = config.github?.repo?.trim() || process.env.GITHUB_REPOSITORY?.split("/")[1]?.trim()
  return owner && repo ? `${owner}/${repo}` : null
}
