import {
  createCapabilityDefinition,
  createGoalDefinition,
  createGoalState,
  createIntentDefinition,
  createLoopDefinition,
  createLoopState,
  createOperationDefinition,
  createWorkflowDefinition,
  type GoalDefinition,
  type GoalState,
  type LoopDefinition,
  type LoopState,
} from "@kody-ade/agency-domain"
import type { AgencyDefinitionDocument, AgencyStateDocument, StateBackend } from "../state-backend.js"

type ManagedDefinition = GoalDefinition | LoopDefinition

export interface ManagedWorkRecord {
  definition: ManagedDefinition
  state: GoalState | LoopState | null
}

export class AgencyModelRepository {
  constructor(
    private readonly backend: Pick<StateBackend, "listAgencyDefinitions" | "getAgencyState" | "putAgencyState">,
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
