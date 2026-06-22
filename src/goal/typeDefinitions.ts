import type { GoalState } from "./state.js"
import type { GoalRouteStep } from "./manager.js"

export type ManagedGoalTypeId = "improve" | "maintain" | "monitor" | "release" | "checklist"

interface ManagedGoalTypeDefinition {
  type: ManagedGoalTypeId
  evidence: string[]
  agentResponsibilities: string[]
  route: GoalRouteStep[]
}

const GOAL_TYPE_DEFINITIONS: Record<ManagedGoalTypeId, ManagedGoalTypeDefinition> = {
  improve: {
    type: "improve",
    evidence: ["planReady", "changeImplemented", "changeVerified"],
    agentResponsibilities: ["plan", "fix", "review"],
    route: [
      { stage: "plan", evidence: "planReady", agentResponsibility: "plan", agentAction: "plan" },
      { stage: "implement", evidence: "changeImplemented", agentResponsibility: "fix", agentAction: "fix" },
      { stage: "review", evidence: "changeVerified", agentResponsibility: "review", agentAction: "review" },
    ],
  },
  maintain: {
    type: "maintain",
    evidence: [],
    agentResponsibilities: ["cleanup", "code-health", "docs-health", "documentation-maintenance", "memory-compaction", "repo-graph", "skills-research"],
    route: [],
  },
  monitor: {
    type: "monitor",
    evidence: [],
    agentResponsibilities: ["health-check", "pr-health-triage", "qa-sweep"],
    route: [],
  },
  release: {
    type: "release",
    evidence: ["releasePrExists", "mainMerged", "productionDeployed"],
    agentResponsibilities: ["release", "release-merge", "vercel-production-deploy"],
    route: [
      {
        stage: "release",
        evidence: "releasePrExists",
        agentResponsibility: "release",
        agentAction: "release-prepare",
        args: { issue: { fact: "issue" }, goal: { fact: "goalId" } },
      },
      {
        stage: "merge",
        evidence: "mainMerged",
        agentResponsibility: "release-merge",
        agentAction: "release-merge",
        args: { pr: { fact: "releasePr" }, issue: { fact: "issue" }, goal: { fact: "goalId" } },
      },
      {
        stage: "publish",
        evidence: "productionDeployed",
        agentResponsibility: "vercel-production-deploy",
        agentAction: "vercel-production-deploy",
        args: { goal: { fact: "goalId" } },
      },
    ],
  },
  checklist: {
    type: "checklist",
    evidence: ["checklistComplete"],
    agentResponsibilities: ["task-verifier"],
    route: [{ stage: "verify", evidence: "checklistComplete", agentResponsibility: "task-verifier", agentAction: "task-verifier" }],
  },
}

function cloneRoute(route: GoalRouteStep[]): GoalRouteStep[] {
  return route.map((step) => ({
    stage: step.stage,
    evidence: step.evidence,
    agentResponsibility: step.agentResponsibility,
    ...(step.agentAction ? { agentAction: step.agentAction } : {}),
    ...(step.args ? { args: structuredClone(step.args) as Record<string, unknown> } : {}),
  }))
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null
}

function routeArray(value: unknown): GoalRouteStep[] | null {
  if (!Array.isArray(value)) return null
  const route: GoalRouteStep[] = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null
    const raw = item as Record<string, unknown>
    if (typeof raw.stage !== "string" || typeof raw.evidence !== "string" || typeof raw.agentResponsibility !== "string") return null
    route.push({
      stage: raw.stage,
      evidence: raw.evidence,
      agentResponsibility: raw.agentResponsibility,
      agentAction: typeof raw.agentAction === "string" ? raw.agentAction : undefined,
      args: raw.args && typeof raw.args === "object" && !Array.isArray(raw.args) ? { ...(raw.args as Record<string, unknown>) } : undefined,
    })
  }
  return route
}

export function managedGoalTypeDefinition(type: string): ManagedGoalTypeDefinition | null {
  return Object.prototype.hasOwnProperty.call(GOAL_TYPE_DEFINITIONS, type)
    ? GOAL_TYPE_DEFINITIONS[type as ManagedGoalTypeId]
    : null
}

export function expandManagedGoalState(state: GoalState): GoalState {
  const type = typeof state.extra.type === "string" ? state.extra.type : ""
  const definition = managedGoalTypeDefinition(type)
  if (!definition) return state

  const destination =
    state.extra.destination && typeof state.extra.destination === "object" && !Array.isArray(state.extra.destination)
      ? { ...(state.extra.destination as Record<string, unknown>) }
      : {}
  const outcome = typeof destination.outcome === "string" ? destination.outcome : ""
  const evidence = stringArray(destination.evidence)
  const agentResponsibilities = stringArray(state.extra.agentResponsibilities)
  const route = routeArray(state.extra.route)
  const facts =
    state.extra.facts && typeof state.extra.facts === "object" && !Array.isArray(state.extra.facts)
      ? { ...(state.extra.facts as Record<string, unknown>) }
      : {}
  const blockers = stringArray(state.extra.blockers)

  return {
    ...state,
    extra: {
      ...state.extra,
      type: definition.type,
      destination: {
        ...destination,
        outcome,
        evidence: evidence && evidence.length > 0 ? evidence : [...definition.evidence],
      },
      agentResponsibilities: agentResponsibilities && agentResponsibilities.length > 0 ? agentResponsibilities : [...definition.agentResponsibilities],
      route: route && route.length > 0 ? route : cloneRoute(definition.route),
      facts,
      blockers: blockers ?? [],
    },
  }
}
