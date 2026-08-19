import { createHash } from "node:crypto"
import type { Job } from "../implementations/types.js"
import type { StateBackend } from "../state-backend.js"

interface PipelineStep { id: string; workflow: string; decisionFact?: string }
interface PipelineDefinition { steps: PipelineStep[] }

function childRunId(runId: string, stepId: string): string {
  return `run-pipeline-${createHash("sha256").update(`${runId}:${stepId}`).digest("hex").slice(0, 40)}`
}

function definition(value: unknown): PipelineDefinition {
  if (!value || typeof value !== "object" || !Array.isArray((value as PipelineDefinition).steps)) {
    throw new Error("Pipeline definition is invalid")
  }
  const steps = (value as PipelineDefinition).steps
  if (steps.length === 0 || steps.some((step) => !step?.id || !step.workflow)) {
    throw new Error("Pipeline definition has no runnable Workflow steps")
  }
  return { steps }
}

export async function runPipelineTarget(input: {
  tenantId: string
  pipelineId: string
  runId: string
  facts: Record<string, unknown>
  backend: Pick<StateBackend, "getPipeline" | "reservePipelineRun" | "markPipelineStepDispatched" | "advancePipelineRun" | "failPipelineRun">
  run: (job: Job, parentRunId: string, loopId: string) => Promise<{ exitCode: number; reason?: string; action?: unknown }>
  parentRunId: string
  loopId: string
}): Promise<{ exitCode: number; reason: string }> {
  const row = await input.backend.getPipeline(input.tenantId, input.pipelineId)
  if (!row) throw new Error(`Pipeline not found: ${input.pipelineId}`)
  const pipeline = definition(row.definition)
  const now = new Date().toISOString()
  const reservation = (await input.backend.reservePipelineRun(input.tenantId, {
    pipelineId: input.pipelineId,
    runId: input.runId,
    facts: input.facts,
    steps: pipeline.steps.map((step) => ({
      id: step.id,
      workflowId: step.workflow,
      ...(step.decisionFact ? { decisionFact: step.decisionFact } : {}),
      status: "pending",
    })),
    now,
  })) as { claimed?: boolean }
  if (!reservation.claimed) return { exitCode: 0, reason: "pipeline already running" }

  let facts = { ...input.facts }
  for (let index = 0; index < pipeline.steps.length; index += 1) {
    const step = pipeline.steps[index]!
    const workflowRunId = childRunId(input.runId, step.id)
    await input.backend.markPipelineStepDispatched(input.tenantId, {
      pipelineId: input.pipelineId,
      runId: input.runId,
      stepIndex: index,
      workflowRunId,
      now: new Date().toISOString(),
    })
    const result = await input.run(
      { workflow: step.workflow, workflowRunId, cliArgs: facts, workflowFacts: facts, flavor: "scheduled" },
      input.parentRunId,
      input.loopId,
    )
    if (result.exitCode !== 0) {
      await input.backend.failPipelineRun(input.tenantId, {
        pipelineId: input.pipelineId,
        runId: input.runId,
        error: result.reason ?? `Workflow ${step.workflow} failed`,
        now: new Date().toISOString(),
      })
      return { exitCode: result.exitCode, reason: result.reason ?? `Workflow ${step.workflow} failed` }
    }
    const output = {
      ...(result.action && typeof result.action === "object" ? result.action : {}),
      ...(result.reason ? { summary: result.reason } : {}),
    }
    const next = (await input.backend.advancePipelineRun(input.tenantId, {
      workflowRunId,
      status: "success",
      output,
      now: new Date().toISOString(),
    })) as { kind?: string; facts?: Record<string, unknown> } | null
    if (next?.facts) facts = next.facts
    if (next?.kind === "approval") return { exitCode: 75, reason: "pipeline is waiting for approval" }
    if (next?.kind === "done") return { exitCode: 0, reason: "pipeline completed" }
  }
  return { exitCode: 0, reason: "pipeline completed" }
}
