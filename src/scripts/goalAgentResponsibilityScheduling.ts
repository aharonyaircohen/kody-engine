import * as path from "node:path"
import type { AgentResponsibilityFolder } from "../agent-responsibilityFolders.js"
import type { KodyConfig } from "../config.js"
import type { ManagedGoal } from "../goal/manager.js"
import { resolveAgentResponsibilityExecution, resolveAgentResponsibilityFolder } from "../registry.js"
import { resolveBackend } from "./jobState/index.js"
import { type ScheduleEvery, scheduleEveryToMs } from "./scheduleEvery.js"

export interface GoalAgentResponsibilityScheduleStatus {
  slug: string
  title?: string
  cadence?: ScheduleEvery
  lastFiredAt?: string
  nextEligibleAt?: string
  state: "due" | "waiting" | "manual" | "disabled" | "blocked"
  reason: string
}

export interface GoalAgentResponsibilityScheduleState {
  mode: "agentLoop"
  lastGoalTickAt: string
  lastDecision:
    | { kind: "dispatch"; agentResponsibility: string; agentAction: string; reason: string; at: string }
    | { kind: "idle"; reason: string; at: string }
    | { kind: "blocked"; reason: string; at: string }
  agentResponsibilities: Record<string, GoalAgentResponsibilityScheduleStatus>
}

export interface GoalAgentResponsibilityScheduleDecision {
  kind: "dispatch" | "idle" | "blocked"
  reason: string
  scheduleState: GoalAgentResponsibilityScheduleState
  dispatch?: {
    agentResponsibility: string
    agentAction: string
    cliArgs: Record<string, unknown>
  }
}

interface PlanGoalAgentResponsibilityScheduleOptions {
  goal: ManagedGoal
  cwd: string
  config: KodyConfig
  jobsDir?: string
  now?: Date
  previousScheduleState?: GoalAgentResponsibilityScheduleState
}

export function isAgentResponsibilityCadenceGoal(goal: ManagedGoal, extra: Record<string, unknown>): boolean {
  return (
    extra.scheduleMode === "agentLoop" ||
    extra.scheduler === "agentLoop" ||
    (goal.type === "standing" && goal.agentResponsibilities.length > 0)
  )
}

export async function planGoalAgentResponsibilitySchedule(
  opts: PlanGoalAgentResponsibilityScheduleOptions,
): Promise<GoalAgentResponsibilityScheduleDecision> {
  const now = opts.now ?? new Date()
  const at = now.toISOString()
  const jobsDir = opts.jobsDir ?? ".kody/agent-responsibilities"
  const jobsRoot = path.join(opts.cwd, jobsDir)
  const backend = resolveBackend({ config: opts.config, cwd: opts.cwd, jobsDir })
  const statuses: Record<string, GoalAgentResponsibilityScheduleStatus> = {}
  const blockers: string[] = []

  for (const slug of opts.goal.agentResponsibilities) {
    const agentResponsibility = resolveAgentResponsibilityFolder(slug, jobsRoot)
    const status = await describeAgentResponsibilitySchedule(
      agentResponsibility,
      slug,
      backend,
      now.getTime(),
      opts.previousScheduleState?.agentResponsibilities[slug],
    )
    statuses[slug] = status
    if (status.state === "blocked") blockers.push(`${slug}: ${status.reason}`)
  }

  const due = opts.goal.agentResponsibilities
    .map((slug) => statuses[slug])
    .find((status): status is GoalAgentResponsibilityScheduleStatus => status?.state === "due")

  if (!due) {
    const reason =
      blockers.length > 0
        ? "no runnable due agentResponsibility; blocked agentResponsibilities need attention"
        : "no agentResponsibility due now"
    const kind = blockers.length > 0 ? "blocked" : "idle"
    return {
      kind,
      reason,
      scheduleState: {
        mode: "agentLoop",
        lastGoalTickAt: at,
        lastDecision: kind === "blocked" ? { kind: "blocked", reason, at } : { kind: "idle", reason, at },
        agentResponsibilities: statuses,
      },
    }
  }

  const agentResponsibility = resolveAgentResponsibilityFolder(due.slug, jobsRoot)
  if (!agentResponsibility) {
    const reason = `${due.slug}: agentResponsibility folder missing`
    return {
      kind: "blocked",
      reason,
      scheduleState: {
        mode: "agentLoop",
        lastGoalTickAt: at,
        lastDecision: { kind: "blocked", reason, at },
        agentResponsibilities: statuses,
      },
    }
  }

  const dispatch = dutyDispatch(agentResponsibility)
  statuses[due.slug] = markAgentResponsibilitySelected(statuses[due.slug]!, now)

  return {
    kind: "dispatch",
    reason: `dispatch ${due.slug}: ${due.reason}`,
    dispatch,
    scheduleState: {
      mode: "agentLoop",
      lastGoalTickAt: at,
      lastDecision: {
        kind: "dispatch",
        agentResponsibility: due.slug,
        agentAction: dispatch.agentAction,
        reason: due.reason,
        at,
      },
      agentResponsibilities: statuses,
    },
  }
}

async function describeAgentResponsibilitySchedule(
  agentResponsibility: AgentResponsibilityFolder | null,
  slug: string,
  backend: ReturnType<typeof resolveBackend>,
  now: number,
  previous?: GoalAgentResponsibilityScheduleStatus,
): Promise<GoalAgentResponsibilityScheduleStatus> {
  if (!agentResponsibility) return { slug, state: "blocked", reason: "agentResponsibility folder missing" }

  const { config } = agentResponsibility
  if (config.disabled === true) {
    return { slug, title: agentResponsibility.title, cadence: config.every, state: "disabled", reason: "disabled" }
  }
  if (config.every === "manual" || (!config.every && !config.agent && config.agentAction)) {
    return { slug, title: agentResponsibility.title, cadence: config.every, state: "manual", reason: "manual only" }
  }
  if (!config.agent || config.agent.trim().length === 0) {
    return {
      slug,
      title: agentResponsibility.title,
      cadence: config.every,
      state: "blocked",
      reason: "no agent assigned",
    }
  }
  if (config.agentActions && config.agentActions.length > 1) {
    return {
      slug,
      title: agentResponsibility.title,
      cadence: config.every,
      state: "blocked",
      reason: "multi-agentAction agentResponsibility needs task-jobs route",
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
      title: agentResponsibility.title,
      cadence: config.every,
      state: "due",
      reason: "state unreadable; run to refresh",
    }
  }

  if (!config.every) {
    return {
      slug,
      title: agentResponsibility.title,
      state: "due",
      reason: "no cadence; check every goal tick",
      lastFiredAt,
    }
  }
  if (!lastFiredAt) {
    return {
      slug,
      title: agentResponsibility.title,
      cadence: config.every,
      state: "due",
      reason: `first check for ${config.every}`,
    }
  }

  const last = Date.parse(lastFiredAt)
  const interval = scheduleEveryToMs(config.every)
  const next = new Date(last + interval).toISOString()
  if (now - last >= interval) {
    return {
      slug,
      title: agentResponsibility.title,
      cadence: config.every,
      state: "due",
      reason: `due ${config.every}`,
      lastFiredAt,
      nextEligibleAt: next,
    }
  }
  return {
    slug,
    title: agentResponsibility.title,
    cadence: config.every,
    state: "waiting",
    reason: `next due ${next}`,
    lastFiredAt,
    nextEligibleAt: next,
  }
}

function dutyDispatch(agentResponsibility: AgentResponsibilityFolder): {
  agentResponsibility: string
  agentAction: string
  cliArgs: Record<string, unknown>
} {
  const { agentAction, cliArgs } = resolveAgentResponsibilityExecution(agentResponsibility)
  return { agentResponsibility: agentResponsibility.slug, agentAction, cliArgs }
}

function validIso(value: string | undefined): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
}

function markAgentResponsibilitySelected(
  status: GoalAgentResponsibilityScheduleStatus,
  now: Date,
): GoalAgentResponsibilityScheduleStatus {
  const lastFiredAt = now.toISOString()
  const nextEligibleAt =
    status.cadence && status.cadence !== "manual"
      ? new Date(now.getTime() + scheduleEveryToMs(status.cadence)).toISOString()
      : status.nextEligibleAt
  return { ...status, lastFiredAt, nextEligibleAt }
}
