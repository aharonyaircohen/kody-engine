import {
  createAgentDefinition,
  createCapabilityDefinition,
  createGoalDefinition,
  createGoalState,
  createIntentDefinition,
  createLoopDefinition,
  createLoopState,
  createOperationDefinition,
  createRunOutput,
  createWorkflowDefinition,
  relationshipIssues,
  type AgentDefinition,
  type CapabilityDefinition,
  type GoalDefinition,
  type GoalState,
  type IntentDefinition,
  type LoopDefinition,
  type LoopState,
  type OperationDefinition,
  type RunOutput,
  type WorkflowDefinition,
} from "@kody-ade/agency-domain"
import type { AgencyDefinitionDocument, AgencyStateDocument, StateBackend } from "../state-backend.js"

type ManagedDefinition = GoalDefinition | LoopDefinition

export interface ManagedWorkRecord {
  definition: ManagedDefinition
  revision: string
  state: GoalState | LoopState | null
}

export interface DefinitionRecord<T> {
  definition: T
  revision: string
}

export interface AgencyDefinitionCatalog {
  intents: ReadonlyMap<string, DefinitionRecord<IntentDefinition>>
  operations: ReadonlyMap<string, DefinitionRecord<OperationDefinition>>
  goals: ReadonlyMap<string, DefinitionRecord<GoalDefinition>>
  loops: ReadonlyMap<string, DefinitionRecord<LoopDefinition>>
  workflows: ReadonlyMap<string, DefinitionRecord<WorkflowDefinition>>
  capabilities: ReadonlyMap<string, DefinitionRecord<CapabilityDefinition>>
  agents: ReadonlyMap<string, DefinitionRecord<AgentDefinition>>
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

  async listManagedWork(catalog?: AgencyDefinitionCatalog): Promise<ManagedWorkRecord[]> {
    const definitions = catalog ?? (await this.loadCatalog())
    const managed = [
      ...Array.from(definitions.goals.values(), ({ definition, revision }) => ({ definition, revision, kind: "goal" as const })),
      ...Array.from(definitions.loops.values(), ({ definition, revision }) => ({ definition, revision, kind: "loop" as const })),
    ]
    return Promise.all(
      managed.map(async (record) => ({
        definition: record.definition,
        revision: record.revision,
        state: parseState(
          await this.backend.getAgencyState(this.tenantId, record.definition.id),
          record.definition,
          record.kind,
        ),
      })),
    )
  }

  async loadCatalog(): Promise<AgencyDefinitionCatalog> {
    const documents = await this.backend.listAgencyDefinitions(this.tenantId)
    const catalog = emptyCatalog()
    // Definitions are append-only. Resolve the current authored revision at
    // the repository boundary instead of making immutable history look like a
    // duplicate domain entity. The record id is a deterministic tie-breaker
    // for imports that preserve identical creation times.
    const ordered = [...documents].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.recordId.localeCompare(right.recordId),
    )
    for (const document of ordered) addDefinition(catalog, document)
    validateRelationships(catalog)
    return catalog
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

function parseState(
  document: AgencyStateDocument | null,
  definition: ManagedDefinition,
  kind: "goal" | "loop",
): GoalState | LoopState | null {
  if (!document) return null
  if (document.schemaVersion !== 1) throw new Error(`Unsupported Agency State schema: ${document.schemaVersion}`)
  if (document.kind !== kind || document.definitionId !== definition.id) {
    throw new Error(`Agency State does not match Definition: ${definition.id}`)
  }
  return document.kind === "goal" ? createGoalState(document.data) : createLoopState(document.data)
}

function emptyCatalog(): AgencyDefinitionCatalog {
  return {
    intents: new Map(),
    operations: new Map(),
    goals: new Map(),
    loops: new Map(),
    workflows: new Map(),
    capabilities: new Map(),
    agents: new Map(),
  }
}

function addDefinition(catalog: AgencyDefinitionCatalog, document: AgencyDefinitionDocument): void {
  if (document.schemaVersion !== 1) throw new Error(`Unsupported Agency Definition schema: ${document.schemaVersion}`)
  if (document.kind === "intent") add(catalog.intents, createIntentDefinition(document.data), document.recordId)
  else if (document.kind === "operation") add(catalog.operations, createOperationDefinition(document.data), document.recordId)
  else if (document.kind === "goal") add(catalog.goals, createGoalDefinition(document.data), document.recordId)
  else if (document.kind === "loop") add(catalog.loops, createLoopDefinition(document.data), document.recordId)
  else if (document.kind === "workflow") add(catalog.workflows, createWorkflowDefinition(document.data), document.recordId)
  else if (document.kind === "capability") add(catalog.capabilities, createCapabilityDefinition(document.data), document.recordId)
  else add(catalog.agents, createAgentDefinition(document.data), document.recordId)
}

function add<T extends { id: string }>(
  collection: ReadonlyMap<string, DefinitionRecord<T>>,
  definition: T,
  revision: string,
): void {
  const mutable = collection as Map<string, DefinitionRecord<T>>
  mutable.set(definition.id, { definition, revision })
}

function validateRelationships(catalog: AgencyDefinitionCatalog): void {
  const relationshipCatalog = {
    operations: [...catalog.operations.keys()],
    goals: [...catalog.goals.keys()],
    workflows: [...catalog.workflows.keys()],
    capabilities: [...catalog.capabilities.keys()],
  }
  const issues = [...catalog.goals.values(), ...catalog.loops.values()].flatMap(({ definition }) =>
    relationshipIssues(definition, relationshipCatalog).map((issue) => `${definition.id}: ${issue}`),
  )
  for (const { definition } of catalog.operations.values()) {
    for (const intentId of definition.intentIds) {
      if (!catalog.intents.has(intentId)) issues.push(`${definition.id}: Missing Intent "${intentId}"`)
    }
  }
  for (const { definition } of catalog.workflows.values()) {
    for (const step of definition.steps) {
      if (!catalog.capabilities.has(step.capabilityRef.id)) {
        issues.push(`${definition.id}: Missing Capability "${step.capabilityRef.id}"`)
      }
    }
  }
  if (issues.length > 0) throw new Error(`Invalid Agency relationships:\n${issues.join("\n")}`)
}
