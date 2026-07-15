import type { WorkflowRunState } from "./implementations/types.js"
import { readStateText, type StateRepoConfig, upsertStateText } from "./stateRepo.js"

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/

export function workflowRunStatePath(workflowId: string, runId: string): string {
  if (!SAFE_ID.test(workflowId)) throw new Error(`invalid workflow id ${workflowId}`)
  if (!SAFE_ID.test(runId)) throw new Error(`invalid workflow run id ${runId}`)
  return `workflows/${workflowId}/runs/${runId}.json`
}

export function parseWorkflowRunState(raw: unknown): WorkflowRunState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const state = raw as Record<string, unknown>
  if (state.status !== "running" && state.status !== "blocked" && state.status !== "failed" && state.status !== "done")
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
    facts: { ...(facts as Record<string, unknown>) },
    evidence: Object.fromEntries(evidenceEntries),
    artifacts: artifacts.map((artifact) => ({ ...artifact })),
    ...(typeof state.blocker === "string" ? { blocker: state.blocker } : {}),
  }
}

export function readWorkflowRunState(
  config: StateRepoConfig,
  cwd: string | undefined,
  workflowId: string,
  runId: string,
): WorkflowRunState | null {
  const file = readStateText(config, cwd, workflowRunStatePath(workflowId, runId))
  if (!file) return null
  try {
    return parseWorkflowRunState(JSON.parse(file.content))
  } catch {
    return null
  }
}

export function writeWorkflowRunState(
  config: StateRepoConfig,
  cwd: string | undefined,
  workflowId: string,
  runId: string,
  state: WorkflowRunState,
): void {
  const path = workflowRunStatePath(workflowId, runId)
  upsertStateText(
    config,
    cwd,
    path,
    `${JSON.stringify(state, null, 2)}\n`,
    `chore(workflows): update ${workflowId} run ${runId}`,
  )
}
