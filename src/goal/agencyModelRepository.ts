import {
  createCapabilityDefinition,
  createGoalDefinition,
  createGoalState,
  createIntentDefinition,
  createLoopDefinition,
  createLoopState,
  createOperationDefinition,
  createRunOutput,
  createWorkflowDefinition,
  type GoalDefinition,
  type GoalState,
  type LoopDefinition,
  type LoopState,
  type RunOutput,
} from "@kody-ade/agency-domain"
import type { AgencyDefinitionDocument, AgencyStateDocument, StateBackend } from "../state-backend.js"

type ManagedDefinition = GoalDefinition | LoopDefinition

export interface ManagedWorkRecord {
  definition: ManagedDefinition
  state: GoalState | LoopState | null
}

export function goalProgressFromOutputs(definition: GoalDefinition, outputs: readonly RunOutput[]): number {
  const required = definition.objective.requiredEvidence
  if (required.length === 0) return 1
  const satisfied = new Set(
    outputs
      .filter((output) => output.kind === "evidence" && output.value === true)
      .map((output) => output.key),
  )
  return required.filter((key) => satisfied.has(key)).length / required.length
}

export class AgencyModelRepository {
  constructor(
    private readonly backend: Pick<
      StateBackend,
      | "listAgencyDefinitions"
      | "getAgencyState"
      | "putAgencyState"
      | "appendAgencyOutput"
      | "listAgencyOutputs"
    >,
    private readonly tenantId: string,
  ) {}

  async listManagedWork(): Promise<ManagedWorkRecord[]> {
    const documents = await this.backend.listAgencyDefinitions(this.tenantId)
    validateAllDefinitions(documents)
    const managed = documents.filter(
      (document): document is AgencyDefinitionDocument & { kind: "goal" | "loop" } =>
        document.kind === "goal" || document.kind === "loop",
    )
    return Promise.all(
      managed.map(async (document) => ({
        definition: parseManagedDefinition(document),
        state: parseState(await this.backend.getAgencyState(this.tenantId, document.recordId), document),
      })),
    )
  }

  async saveState(state: GoalState | LoopState, kind: "goal" | "loop", updatedAt: string): Promise<void> {
    const data = kind === "goal" ? createGoalState(state) : createLoopState(state)
    await this.backend.putAgencyState(this.tenantId, state.definitionId, kind, 1, data, updatedAt)
  }

  async appendOutput(recordId: string, output: RunOutput): Promise<void> {
    await this.backend.appendAgencyOutput(this.tenantId, recordId, 1, createRunOutput(output))
  }

  async listOutputs(runId?: string): Promise<RunOutput[]> {
    const documents = await this.backend.listAgencyOutputs(this.tenantId, runId)
    return documents.map((document) => {
      if (document.schemaVersion !== 1) {
        throw new Error(`Unsupported Agency Output schema: ${document.schemaVersion}`)
      }
      const output = createRunOutput(document.data)
      if (output.runId !== document.runId) throw new Error(`Agency Output does not match Run: ${document.recordId}`)
      return output
    })
  }

  async refreshGoalProgress(record: ManagedWorkRecord, updatedAt: string): Promise<GoalState> {
    if (!("executionRef" in record.definition)) throw new Error("Only a Goal has progress")
    const previous = record.state
    if (previous && !("progress" in previous)) throw new Error("Goal Definition has Loop State")
    const state = createGoalState({
      definitionId: record.definition.id,
      lifecycle: previous?.lifecycle ?? "draft",
      progress: goalProgressFromOutputs(record.definition, await this.listOutputs()),
      blockers: previous?.blockers ?? [],
      updatedAt,
    })
    await this.saveState(state, "goal", updatedAt)
    return state
  }
}

function validateAllDefinitions(documents: AgencyDefinitionDocument[]): void {
  for (const document of documents) {
    if (document.schemaVersion !== 1) throw new Error(`Unsupported Agency Definition schema: ${document.schemaVersion}`)
    if (document.kind === "intent") createIntentDefinition(document.data)
    else if (document.kind === "operation") createOperationDefinition(document.data)
    else if (document.kind === "goal") createGoalDefinition(document.data)
    else if (document.kind === "loop") createLoopDefinition(document.data)
    else if (document.kind === "workflow") createWorkflowDefinition(document.data)
    else createCapabilityDefinition(document.data)
  }
}

function parseManagedDefinition(document: AgencyDefinitionDocument): ManagedDefinition {
  return document.kind === "goal" ? createGoalDefinition(document.data) : createLoopDefinition(document.data)
}

function parseState(
  document: AgencyStateDocument | null,
  definition: AgencyDefinitionDocument & { kind: "goal" | "loop" },
): GoalState | LoopState | null {
  if (!document) return null
  if (document.schemaVersion !== 1) throw new Error(`Unsupported Agency State schema: ${document.schemaVersion}`)
  if (document.kind !== definition.kind || document.definitionId !== definition.recordId) {
    throw new Error(`Agency State does not match Definition: ${definition.recordId}`)
  }
  return document.kind === "goal" ? createGoalState(document.data) : createLoopState(document.data)
}
