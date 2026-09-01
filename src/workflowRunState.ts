import type { WorkflowRunState } from "./implementations/types.js"
import { createStateBackendFromEnv } from "./state-backend.js"

interface WorkflowBackendConfig {
  github?: { owner?: string; repo?: string }
}

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/

export function workflowRunStatePath(workflowId: string, runId: string): string {
  if (!SAFE_ID.test(workflowId)) throw new Error(`invalid workflow id ${workflowId}`)
  if (!SAFE_ID.test(runId)) throw new Error(`invalid workflow run id ${runId}`)
  return `workflows/${workflowId}/runs/${runId}.json`
}

export function parseWorkflowRunState(raw: unknown): WorkflowRunState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const state = raw as Record<string, unknown>
  if (
    state.status !== "running" &&
    state.status !== "waiting-approval" &&
    state.status !== "blocked" &&
    state.status !== "failed" &&
    state.status !== "done"
  )
    return null
  const completedStepIds = Array.isArray(state.completedStepIds)
    ? state.completedStepIds.filter((value): value is string => typeof value === "string")
    : []
  const transitionCounts =
    state.transitionCounts && typeof state.transitionCounts === "object" && !Array.isArray(state.transitionCounts)
      ? Object.fromEntries(
          Object.entries(state.transitionCounts).filter(
            (entry): entry is [string, number] =>
              typeof entry[1] === "number" && Number.isInteger(entry[1]) && entry[1] >= 0,
          ),
        )
      : {}
  const facts = state.facts && typeof state.facts === "object" && !Array.isArray(state.facts) ? state.facts : {}
  const input = state.input && typeof state.input === "object" && !Array.isArray(state.input) ? state.input : undefined
  const steps = parseWorkflowSteps(state.steps)
  const evidenceEntries =
    state.evidence && typeof state.evidence === "object" && !Array.isArray(state.evidence)
      ? Object.entries(state.evidence).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
      : []
  const artifacts = Array.isArray(state.artifacts)
    ? state.artifacts.filter(
        (artifact): artifact is { label: string; url?: string; path?: string } =>
          !!artifact &&
          typeof artifact === "object" &&
          typeof (artifact as { label?: unknown }).label === "string" &&
          ((artifact as { url?: unknown }).url === undefined ||
            typeof (artifact as { url?: unknown }).url === "string") &&
          ((artifact as { path?: unknown }).path === undefined ||
            typeof (artifact as { path?: unknown }).path === "string"),
      )
    : []
  return {
    status: state.status,
    ...(typeof state.currentStepId === "string" ? { currentStepId: state.currentStepId } : {}),
    completedStepIds,
    transitionCounts,
    ...(parseWorkflowApproval(state.approval) ? { approval: parseWorkflowApproval(state.approval)! } : {}),
    ...(input ? { input: { ...(input as Record<string, unknown>) } } : {}),
    ...(typeof state.definitionHash === "string" && state.definitionHash.trim()
      ? { definitionHash: state.definitionHash.trim() }
      : {}),
    ...(steps ? { steps } : {}),
    facts: { ...(facts as Record<string, unknown>) },
    evidence: Object.fromEntries(evidenceEntries),
    artifacts: artifacts.map((artifact) => ({ ...artifact })),
    ...(typeof state.blocker === "string" ? { blocker: state.blocker } : {}),
  }
}

function parseWorkflowApproval(value: unknown): WorkflowRunState["approval"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const approval = value as Record<string, unknown>
  if (
    typeof approval.stepId !== "string" ||
    typeof approval.action !== "string" ||
    typeof approval.contextHash !== "string" ||
    (approval.status !== "pending" && approval.status !== "approved" && approval.status !== "consumed")
  )
    return undefined
  return {
    stepId: approval.stepId,
    action: approval.action,
    contextHash: approval.contextHash,
    status: approval.status,
    ...(typeof approval.approvedAt === "string" ? { approvedAt: approval.approvedAt } : {}),
    ...(typeof approval.approvedBy === "string" ? { approvedBy: approval.approvedBy } : {}),
  }
}

function parseWorkflowSteps(value: unknown): WorkflowRunState["steps"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const steps: NonNullable<WorkflowRunState["steps"]> = {}
  for (const [stepId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const step = raw as Record<string, unknown>
    if (
      step.status !== "running" &&
      step.status !== "completed" &&
      step.status !== "blocked" &&
      step.status !== "failed"
    ) {
      continue
    }
    steps[stepId] = {
      status: step.status,
      ...(typeof step.capability === "string" ? { capability: step.capability } : {}),
      ...(Object.hasOwn(step, "input") ? { input: step.input } : {}),
      ...(Object.hasOwn(step, "output") ? { output: step.output } : {}),
      ...(typeof step.startedAt === "string" ? { startedAt: step.startedAt } : {}),
      ...(typeof step.completedAt === "string" ? { completedAt: step.completedAt } : {}),
    }
  }
  return Object.keys(steps).length > 0 ? steps : undefined
}

export async function readWorkflowRunState(
  config: WorkflowBackendConfig,
  _cwd: string | undefined,
  workflowId: string,
  runId: string,
): Promise<WorkflowRunState | null> {
  const tenantId = workflowRuntimeTenant(config)
  const row = await createStateBackendFromEnv().getWorkflowRun(tenantId, workflowId, runId)
  return row ? parseWorkflowRunState(row.state) : null
}

export async function writeWorkflowRunState(
  config: WorkflowBackendConfig,
  _cwd: string | undefined,
  workflowId: string,
  runId: string,
  state: WorkflowRunState,
): Promise<void> {
  workflowRunStatePath(workflowId, runId)
  await createStateBackendFromEnv().saveWorkflowRun(
    workflowRuntimeTenant(config),
    workflowId,
    runId,
    state,
    new Date().toISOString(),
  )
}

export function workflowRuntimeTenant(config: WorkflowBackendConfig): string {
  if (config.github?.owner && config.github.repo) return `${config.github.owner}/${config.github.repo}`
  const tenantId = process.env.GITHUB_REPOSITORY?.trim()
  if (!tenantId) throw new Error("Repository identity is required for workflow run state")
  return tenantId
}
