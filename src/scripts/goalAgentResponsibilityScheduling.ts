import * as path from "node:path"
import type { AgentResponsibilityFolder } from "../agent-responsibilityFolders.js"
import type { KodyConfig } from "../config.js"
import type { ManagedGoal } from "../goal/manager.js"
import { resolveAgentResponsibilityExecution, resolveAgentResponsibilityFolder } from "../registry.js"
import { resolveBackend } from "./jobState/index.js"

export interface GoalAgentResponsibilityScheduleStatus {
  slug: string
  title?: string
  lastFiredAt?: string
  state: "due" | "disabled" | "blocked"
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
  const jobsDir = opts.jobsDir ?? ".kody/agent-responsibilities"
  const jobsRoot = path.join(opts.cwd, jobsDir)
  const now = opts.now ?? new Date()
  const at = now.toISOString()
  const backend = resolveBackend({ config: opts.config, cwd: opts.cwd, jobsDir })
  const statuses: Record<string, GoalAgentResponsibilityScheduleStatus> = {}
  const blockers: string[] = []

  for (const slug of opts.goal.agentResponsibilities) {
    const agentResponsibility = resolveAgentResponsibilityFolder(slug, jobsRoot)
    const status = await describeAgentResponsibilitySchedule(
      agentResponsibility,
      slug,
      backend,
      opts.previousScheduleState?.agentResponsibilities[slug],
    )
    statuses[slug] = status
    if (status.state === "blocked") blockers.push(`${slug}: ${status.reason}`)
  }

  const due = opts.goal.agentResponsibilities
    .map((slug) => statuses[slug])
    .filter((status): status is GoalAgentResponsibilityScheduleStatus => status?.state === "due")
    .sort(compareOldestLastFired)[0]

  if (!due) {
    const reason =
      blockers.length > 0
        ? "no runnable agentResponsibility; blocked agentResponsibilities need attention"
        : "no runnable agentResponsibility"
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
  previous?: GoalAgentResponsibilityScheduleStatus,
): Promise<GoalAgentResponsibilityScheduleStatus> {
  if (!agentResponsibility) return { slug, state: "blocked", reason: "agentResponsibility folder missing" }

  const { config } = agentResponsibility
  if (config.disabled === true) {
    return { slug, title: agentResponsibility.title, state: "disabled", reason: "disabled" }
  }
  if (!config.agent || config.agent.trim().length === 0) {
    return { slug, title: agentResponsibility.title, state: "blocked", reason: "no agent assigned" }
  }
  if (config.agentActions && config.agentActions.length > 1) {
    return {
      slug,
      title: agentResponsibility.title,
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
      state: "due",
      reason: "state unreadable; ready for loop tick",
    }
  }

  return {
    slug,
    title: agentResponsibility.title,
    state: "due",
    reason: "ready for loop tick",
    lastFiredAt,
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

function compareOldestLastFired(
  a: GoalAgentResponsibilityScheduleStatus,
  b: GoalAgentResponsibilityScheduleStatus,
): number {
  const aTime = validIso(a.lastFiredAt) ? Date.parse(a.lastFiredAt) : Number.NEGATIVE_INFINITY
  const bTime = validIso(b.lastFiredAt) ? Date.parse(b.lastFiredAt) : Number.NEGATIVE_INFINITY
  return aTime - bTime
}

function validIso(value: string | undefined): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
}

function markAgentResponsibilitySelected(
  status: GoalAgentResponsibilityScheduleStatus,
  now: Date,
): GoalAgentResponsibilityScheduleStatus {
  return { ...status, lastFiredAt: now.toISOString() }
}
