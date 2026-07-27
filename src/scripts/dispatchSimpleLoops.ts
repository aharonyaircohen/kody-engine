import { randomUUID } from "node:crypto"
import type { KodyConfig } from "../config.js"
import { listLoopDefinitions, type LoopDefinition } from "../loopDefinitions.js"
import type { Job, PreflightScript } from "../implementations/types.js"
import { runJob } from "../job.js"
import { createStateBackendFromEnv } from "../state-backend.js"

export const dispatchSimpleLoops: PreflightScript = async (ctx) => {
  const tenantId = repositoryTenant(ctx.config)
  if (!tenantId) throw new Error("Repository identity is required for Loop dispatch")
  const now = new Date()
  const force = ctx.data.jobForce === true
  const requestedLoopId =
    typeof ctx.args.loop === "string" ? ctx.args.loop.trim() : ""
  const due = selectRunnableLoops(listLoopDefinitions(ctx.cwd), now, {
    force,
    ...(requestedLoopId ? { loopId: requestedLoopId } : {}),
  })
  process.stdout.write(
    `→ kody: Loop scheduler found ${due.length} runnable Loop(s)${force ? " (manual)" : ""}\n`,
  )
  const backend = createStateBackendFromEnv()
  const results: Array<{ loopId: string; status: string; reason: string }> = []

  for (const loop of due) {
    const slot = loopDispatchSlot(loop, now, force, randomUUID())
    if (!slot) continue
    const reservationId = `reservation-${randomUUID()}`
    const idempotencyKey = `${loop.id}:${slot}`
    const claimed = await backend.reserveAgencyDispatch(tenantId, {
      idempotencyKey,
      loopId: loop.id,
      decision: {
        kind: "fire",
        reason: force ? "manual Loop run requested" : "local Loop schedule is due",
        scheduledAt: slot,
      },
      leaseUntil: new Date(now.getTime() + 6 * 60 * 60 * 1_000).toISOString(),
      reservationId,
      correlationId: `corr-${randomUUID()}`,
      policyHash: `loop:${loop.id}`,
      effectivePolicy: { source: "repository" },
      definitionRefs: [{ kind: "loop", id: loop.id }],
      maxConcurrentRuns: 1,
      requiresApproval: false,
      approvalScopeKind: "loop",
      approvalScopeId: loop.id,
      approvalAction: `${loop.target.kind}:${loop.target.id}`,
      now: now.toISOString(),
    })
    if (!claimed.acquired) {
      results.push({ loopId: loop.id, status: "skipped", reason: claimed.reason ?? "already claimed" })
      continue
    }

    const result = await runJob(loopJob(loop), {
      cwd: ctx.cwd,
      config: ctx.config,
      verbose: ctx.verbose,
      quiet: ctx.quiet,
      chain: false,
    })
    const status = result.exitCode === 0 ? "dispatched" : "failed"
    await backend.finishAgencyDispatch(tenantId, idempotencyKey, reservationId, status, new Date().toISOString())
    results.push({ loopId: loop.id, status, reason: result.reason ?? status })
  }
  for (const result of results) {
    process.stdout.write(
      `→ kody: Loop ${result.loopId} ${result.status}: ${result.reason}\n`,
    )
  }
  ctx.data.simpleLoopDispatchResults = results
}

export function selectRunnableLoops(
  loops: readonly LoopDefinition[],
  now: Date,
  options: { force: boolean; loopId?: string },
): LoopDefinition[] {
  return loops.filter(
    (loop) =>
      loop.enabled &&
      loop.trigger.type === "schedule" &&
      (!options.loopId || loop.id === options.loopId) &&
      (options.force || dueSlot(loop, now) !== null),
  )
}

export function loopDispatchSlot(
  loop: LoopDefinition,
  now: Date,
  force: boolean,
  nonce: string,
): string | null {
  return force ? `manual:${now.toISOString()}:${nonce}` : dueSlot(loop, now)
}

export function dueSlot(loop: LoopDefinition, now: Date): string | null {
  if (!loop.enabled || loop.trigger.type !== "schedule") return null
  const match = /^(\d+)([mhd])$/.exec(loop.trigger.every)
  if (!match) return null
  const amount = Number(match[1])
  const unit = match[2]
  const milliseconds = amount * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000)
  const slot = Math.floor(now.getTime() / milliseconds) * milliseconds
  if (!loop.trigger.at) return new Date(slot).toISOString()

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: loop.trigger.at.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)
  const hour = parts.find((part) => part.type === "hour")?.value
  const minute = parts.find((part) => part.type === "minute")?.value
  const [targetHour, targetMinute] = loop.trigger.at.time.split(":").map(Number)
  const localMinute = Number(hour) * 60 + Number(minute)
  const targetLocalMinute = Number(targetHour) * 60 + Number(targetMinute)
  const windowMinutes = Math.max(1, Math.ceil(Number(process.env.KODY_SCHEDULE_WINDOW_SEC || 300) / 60))
  if (localMinute < targetLocalMinute || localMinute >= targetLocalMinute + windowMinutes) return null
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  const day = parts.find((part) => part.type === "day")?.value
  return `${year}-${month}-${day}T${loop.trigger.at.time}[${loop.trigger.at.timezone}]`
}

function loopJob(loop: LoopDefinition): Job {
  const cliArgs = Object.fromEntries(
    Object.entries(loop.input).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
  )
  return loop.target.kind === "workflow"
    ? { workflow: loop.target.id, cliArgs, flavor: "scheduled" }
    : { capability: loop.target.id, cliArgs, flavor: "scheduled" }
}

function repositoryTenant(config: KodyConfig): string | null {
  const [envOwner, envRepo] = (process.env.GITHUB_REPOSITORY ?? "").split("/")
  const owner = config.github?.owner?.trim() || envOwner?.trim()
  const repo = config.github?.repo?.trim() || envRepo?.trim()
  return owner && repo ? `${owner}/${repo}` : null
}
