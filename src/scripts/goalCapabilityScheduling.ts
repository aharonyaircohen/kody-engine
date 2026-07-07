import * as path from "node:path"
import type { CapabilityFolder } from "../capabilityFolders.js"
import type { KodyConfig } from "../config.js"
import type { ManagedGoal } from "../goal/manager.js"
import { resolveCapabilityExecution, resolveCapabilityFolder } from "../registry.js"
import { resolveBackend } from "./jobState/index.js"

export interface GoalCapabilityScheduleStatus {
  slug: string
  title?: string
  lastFiredAt?: string
  state: "due" | "disabled" | "blocked"
  reason: string
}

export interface GoalCapabilityScheduleState {
  mode: "agentLoop"
  lastGoalTickAt: string
  lastDecision:
    | { kind: "dispatch"; capability: string; implementation: string; reason: string; at: string }
    | {
        kind: "dispatch"
        targetType: "goal" | "workflow"
        targetId: string
        action?: string
        capability?: string
        workflow?: string
        implementation?: string
        reason: string
        at: string
      }
    | { kind: "idle"; reason: string; at: string }
    | { kind: "blocked"; reason: string; at: string }
  capabilities: Record<string, GoalCapabilityScheduleStatus>
}

export interface GoalCapabilityScheduleDecision {
  kind: "dispatch" | "idle" | "blocked"
  reason: string
  scheduleState: GoalCapabilityScheduleState
  dispatch?: {
    action?: string
    capability?: string
    workflow?: string
    implementation?: string
    cliArgs: Record<string, unknown>
  }
}

interface PlanGoalCapabilityScheduleOptions {
  goal: ManagedGoal
  cwd: string
  config: KodyConfig
  jobsDir?: string
  now?: Date
  previousScheduleState?: GoalCapabilityScheduleState
}

export function isCapabilityCadenceGoal(goal: ManagedGoal, extra: Record<string, unknown>): boolean {
  return (
    extra.scheduleMode === "agentLoop" ||
    extra.scheduler === "agentLoop" ||
    (goal.type === "standing" && goal.capabilities.length > 0)
  )
}

export function isGoalTargetLoop(goal: ManagedGoal): boolean {
  return goal.type === "agentLoop" && goal.loopTarget?.type === "goal" && goal.loopTarget.id.trim().length > 0
}

export function isWorkflowTargetLoop(goal: ManagedGoal): boolean {
  return goal.type === "agentLoop" && goal.loopTarget?.type === "workflow" && goal.loopTarget.id.trim().length > 0
}

export function planTargetLoopSchedule(opts: {
  goal: ManagedGoal
  now?: Date
  previousScheduleState?: GoalCapabilityScheduleState
  resolvedGoalTargetId?: string
  allowSameDayTargetDispatch?: boolean
}): GoalCapabilityScheduleDecision {
  const now = opts.now ?? new Date()
  const at = now.toISOString()
  const target = opts.goal.loopTarget
  const targetId = target?.id.trim() ?? ""
  if (!targetId) {
    const reason = "loop missing target"
    return targetLoopDecision("blocked", reason, at)
  }
  if (target?.type !== "goal" && target?.type !== "workflow") {
    const reason = `unsupported loop target: ${String(target?.type ?? "missing")}`
    return targetLoopDecision("blocked", reason, at)
  }

  const preferred = opts.goal.preferredRunTime
  if (preferred) {
    const gate = preferredRunTimeGate(preferred, now, opts.previousScheduleState, {
      allowSameDayTargetDispatch: opts.allowSameDayTargetDispatch === true,
    })
    if (!gate.ok) return targetLoopDecision("idle", gate.reason, at)
  }

  const dispatchTargetId =
    target.type === "goal" && opts.resolvedGoalTargetId?.trim() ? opts.resolvedGoalTargetId.trim() : targetId
  const dispatch: NonNullable<GoalCapabilityScheduleDecision["dispatch"]> =
    target.type === "goal"
      ? { action: "goal-manager", implementation: "goal-manager", cliArgs: { goal: dispatchTargetId } }
      : { workflow: targetId, cliArgs: {} }

  return {
    kind: "dispatch",
    reason: `dispatch ${target.type} ${target.type === "goal" ? dispatchTargetId : targetId}`,
    dispatch,
    scheduleState: {
      mode: "agentLoop",
      lastGoalTickAt: at,
      lastDecision: {
        kind: "dispatch",
        targetType: target.type,
        targetId: target.type === "goal" ? dispatchTargetId : targetId,
        ...(dispatch.action ? { action: dispatch.action } : {}),
        ...(dispatch.capability ? { capability: dispatch.capability } : {}),
        ...(dispatch.workflow ? { workflow: dispatch.workflow } : {}),
        ...(dispatch.implementation ? { implementation: dispatch.implementation } : {}),
        reason: preferred ? `preferred time ${preferred.time} ${preferred.timezone}` : "ready target loop tick",
        at,
      },
      capabilities: {},
    },
  }
}

export async function planGoalCapabilitySchedule(
  opts: PlanGoalCapabilityScheduleOptions,
): Promise<GoalCapabilityScheduleDecision> {
  const jobsDir = opts.jobsDir ?? ".kody/capabilities"
  const jobsRoot = path.join(opts.cwd, jobsDir)
  const now = opts.now ?? new Date()
  const at = now.toISOString()
  const backend = resolveBackend({ config: opts.config, cwd: opts.cwd, jobsDir })
  const statuses: Record<string, GoalCapabilityScheduleStatus> = {}
  const blockers: string[] = []
  const explicitCapabilityTarget = opts.goal.loopTarget?.type === "capability" ? opts.goal.loopTarget.id.trim() : ""
  const capabilitySlugs = explicitCapabilityTarget ? [explicitCapabilityTarget] : opts.goal.capabilities

  for (const slug of capabilitySlugs) {
    const capability = resolveCapabilityFolder(slug, jobsRoot)
    const status = await describeCapabilitySchedule(
      capability,
      slug,
      backend,
      opts.previousScheduleState?.capabilities[slug],
    )
    statuses[slug] = status
    if (status.state === "blocked") blockers.push(`${slug}: ${status.reason}`)
  }

  const due = capabilitySlugs
    .map((slug) => statuses[slug])
    .filter((status): status is GoalCapabilityScheduleStatus => status?.state === "due")
    .sort(compareOldestLastFired)[0]

  if (!due) {
    const reason =
      blockers.length > 0 ? "no runnable capability; blocked capabilities need attention" : "no runnable capability"
    const kind = blockers.length > 0 ? "blocked" : "idle"
    return {
      kind,
      reason,
      scheduleState: {
        mode: "agentLoop",
        lastGoalTickAt: at,
        lastDecision: kind === "blocked" ? { kind: "blocked", reason, at } : { kind: "idle", reason, at },
        capabilities: statuses,
      },
    }
  }

  const capability = resolveCapabilityFolder(due.slug, jobsRoot)
  if (!capability) {
    const reason = `${due.slug}: capability folder missing`
    return {
      kind: "blocked",
      reason,
      scheduleState: {
        mode: "agentLoop",
        lastGoalTickAt: at,
        lastDecision: { kind: "blocked", reason, at },
        capabilities: statuses,
      },
    }
  }

  const dispatch = capabilityDispatch(capability)
  statuses[due.slug] = markCapabilitySelected(statuses[due.slug]!, now)

  return {
    kind: "dispatch",
    reason: `dispatch ${due.slug}: ${due.reason}`,
    dispatch,
    scheduleState: {
      mode: "agentLoop",
      lastGoalTickAt: at,
      lastDecision: {
        kind: "dispatch",
        capability: due.slug,
        implementation: dispatch.implementation,
        reason: due.reason,
        at,
      },
      capabilities: statuses,
    },
  }
}

async function describeCapabilitySchedule(
  capability: CapabilityFolder | null,
  slug: string,
  backend: ReturnType<typeof resolveBackend>,
  previous?: GoalCapabilityScheduleStatus,
): Promise<GoalCapabilityScheduleStatus> {
  if (!capability) return { slug, state: "blocked", reason: "capability folder missing" }

  const { config } = capability
  if (config.disabled === true) {
    return { slug, title: capability.title, state: "disabled", reason: "disabled" }
  }
  if (!config.agent || config.agent.trim().length === 0) {
    return { slug, title: capability.title, state: "blocked", reason: "no agent assigned" }
  }
  if (config.implementations && config.implementations.length > 1) {
    return {
      slug,
      title: capability.title,
      state: "blocked",
      reason: "multi-implementation capability needs task-jobs route",
    }
  }

  let lastFiredAt = validIso(previous?.lastFiredAt) ? previous?.lastFiredAt : undefined
  try {
    if (!lastFiredAt) {
      const loaded = await backend.load(slug)
      const raw = loaded.state.data?.lastFiredAt
      if (typeof raw === "string" && validIso(raw)) lastFiredAt = raw
    }
  } catch {
    return {
      slug,
      title: capability.title,
      state: "due",
      reason: "state unreadable; ready for loop tick",
    }
  }

  return {
    slug,
    title: capability.title,
    state: "due",
    reason: "ready for loop tick",
    lastFiredAt,
  }
}

function capabilityDispatch(capability: CapabilityFolder): {
  capability: string
  implementation: string
  cliArgs: Record<string, unknown>
} {
  const { implementation, cliArgs } = resolveCapabilityExecution(capability)
  return { capability: capability.slug, implementation, cliArgs }
}

function compareOldestLastFired(a: GoalCapabilityScheduleStatus, b: GoalCapabilityScheduleStatus): number {
  const aTime = validIso(a.lastFiredAt) ? Date.parse(a.lastFiredAt) : Number.NEGATIVE_INFINITY
  const bTime = validIso(b.lastFiredAt) ? Date.parse(b.lastFiredAt) : Number.NEGATIVE_INFINITY
  return aTime - bTime
}

function validIso(value: string | undefined): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
}

function markCapabilitySelected(status: GoalCapabilityScheduleStatus, now: Date): GoalCapabilityScheduleStatus {
  return { ...status, lastFiredAt: now.toISOString() }
}

function targetLoopDecision(kind: "idle" | "blocked", reason: string, at: string): GoalCapabilityScheduleDecision {
  return {
    kind,
    reason,
    scheduleState: {
      mode: "agentLoop",
      lastGoalTickAt: at,
      lastDecision: { kind, reason, at },
      capabilities: {},
    },
  }
}

function preferredRunTimeGate(
  preferred: { time: string; timezone: string },
  now: Date,
  previous?: GoalCapabilityScheduleState,
  opts?: { allowSameDayTargetDispatch?: boolean },
): { ok: true } | { ok: false; reason: string } {
  const current = zonedTimeParts(now, preferred.timezone)
  if (!current) return { ok: false, reason: `invalid preferred timezone: ${preferred.timezone}` }

  const preferredMinute = preferredTimeToMinute(preferred.time)
  if (preferredMinute === null) return { ok: false, reason: `invalid preferred time: ${preferred.time}` }

  const currentMinute = current.hour * 60 + current.minute
  if (currentMinute < preferredMinute) {
    return { ok: false, reason: `waiting preferred time ${preferred.time} ${preferred.timezone}` }
  }

  const lastDispatchAt = previous?.lastDecision.kind === "dispatch" ? previous.lastDecision.at : undefined
  if (lastDispatchAt) {
    const last = zonedTimeParts(new Date(lastDispatchAt), preferred.timezone)
    if (last?.date === current.date && opts?.allowSameDayTargetDispatch !== true) {
      return { ok: false, reason: `already dispatched today at preferred time ${preferred.time} ${preferred.timezone}` }
    }
  }

  return { ok: true }
}

function preferredTimeToMinute(value: string): number | null {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

function zonedTimeParts(date: Date, timezone: string): { date: string; hour: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date)
    const get = (type: string) => parts.find((part) => part.type === type)?.value
    const year = get("year")
    const month = get("month")
    const day = get("day")
    const hour = get("hour")
    const minute = get("minute")
    if (!year || !month || !day || !hour || !minute) return null
    return { date: `${year}-${month}-${day}`, hour: Number(hour), minute: Number(minute) }
  } catch {
    return null
  }
}
