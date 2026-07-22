import type { ConvexHttpClient } from "convex/browser"
import type { FunctionReference } from "convex/server"
import { anyApi } from "convex/server"
import { createConvexClientFromEnv } from "./chat/convex-client.js"
import { createKodyApiBackendClient, hasGitHubActionsIdentity } from "./kody-api-client.js"

export interface TaskDocument {
  tenantId: string
  taskKey: string
  kind: string
  doc: unknown
  updatedAt: string
}

export interface GoalDocument {
  tenantId: string
  goalId: string
  state: unknown
  updatedAt: string
}

export interface AgencyRunDocument {
  tenantId: string
  runId: string
  subjectType: "goal" | "loop" | "workflow" | "capability"
  subjectId: string
  run: unknown
  updatedAt: string
}

export interface AgencyDefinitionDocument {
  tenantId: string
  recordId: string
  kind: "intent" | "operation" | "goal" | "loop" | "workflow" | "capability" | "agent"
  schemaVersion: number
  data: unknown
  createdAt: string
}

export interface AgencyStateDocument {
  tenantId: string
  definitionId: string
  kind: "goal" | "loop"
  schemaVersion: number
  data: unknown
  updatedAt: string
}

export interface AgencyOutputDocument {
  tenantId: string
  recordId: string
  schemaVersion: number
  runId: string
  data: unknown
}

export interface AgencyDispatchDecision {
  kind: "fire" | "skip"
  reason: string
  scheduledAt?: string
  nextEligibleAt?: string
}

function serializeAgencyDispatchDecision(decision: AgencyDispatchDecision): AgencyDispatchDecision {
  return {
    kind: decision.kind,
    reason: decision.reason,
    ...(decision.scheduledAt ? { scheduledAt: decision.scheduledAt } : {}),
    ...(decision.nextEligibleAt ? { nextEligibleAt: decision.nextEligibleAt } : {}),
  }
}

export interface AgencyDispatchReservation {
  idempotencyKey: string
  loopId: string
  decision: AgencyDispatchDecision
  leaseUntil: string
  reservationId: string
  correlationId: string
  policyHash: string
  effectivePolicy: unknown
  definitionRefs: unknown[]
  maxConcurrentRuns: number
  requiresApproval: boolean
  approvalScopeKind: "loop" | "goal" | "workflow" | "capability"
  approvalScopeId: string
  approvalAction: string
  now: string
}

export interface DefinitionDocument {
  slug: string
  version: string
  bundle: {
    schemaVersion: 1
    files: Record<string, string>
  }
  updatedAt: string
}

export interface WorkflowDocument {
  workflowId: string
  definition: unknown
  source: "local" | "store"
  updatedAt: string
}

export interface StateBackendClient {
  query: (fn: FunctionReference<"query">, args: Record<string, unknown>) => Promise<unknown>
  mutation: (fn: FunctionReference<"mutation">, args: Record<string, unknown>) => Promise<unknown>
}

export interface StateBackend {
  get(tenantId: string, taskKey: string, kind: string): Promise<TaskDocument | null>
  save(tenantId: string, taskKey: string, kind: string, doc: unknown, expectedUpdatedAt?: string): Promise<void>
  getRepoDoc(tenantId: string, kind: string): Promise<TaskDocument | null>
  listRepoDocs(tenantId: string, prefix: string): Promise<TaskDocument[]>
  saveRepoDoc(tenantId: string, kind: string, doc: unknown, expectedUpdatedAt?: string): Promise<void>
  getGoal(tenantId: string, goalId: string): Promise<GoalDocument | null>
  listGoals(tenantId: string): Promise<GoalDocument[]>
  saveGoal(
    tenantId: string,
    goalId: string,
    state: unknown,
    updatedAt: string,
    expectedUpdatedAt?: string,
  ): Promise<void>
  appendDailyLog(
    tenantId: string,
    stream: "activity" | "events" | "flyActivity",
    date: string,
    entry: unknown,
  ): Promise<void>
  appendChatEvent(tenantId: string, sessionId: string, event: unknown): Promise<void>
  saveAgencyRun(
    tenantId: string,
    runId: string,
    subjectType: AgencyRunDocument["subjectType"],
    subjectId: string,
    run: unknown,
    updatedAt: string,
  ): Promise<void>
  listAgencyDefinitions(tenantId: string): Promise<AgencyDefinitionDocument[]>
  getAgencyState(tenantId: string, definitionId: string): Promise<AgencyStateDocument | null>
  putAgencyState(
    tenantId: string,
    definitionId: string,
    kind: AgencyStateDocument["kind"],
    schemaVersion: number,
    data: unknown,
    updatedAt: string,
  ): Promise<void>
  appendAgencyOutput(
    tenantId: string,
    recordId: string,
    schemaVersion: number,
    data: unknown,
  ): Promise<void>
  listAgencyOutputs(tenantId: string, runId?: string): Promise<AgencyOutputDocument[]>
  reserveAgencyDispatch(
    tenantId: string,
    reservation: AgencyDispatchReservation,
  ): Promise<{
    acquired: boolean
    dispatchId?: string
    reason?: "duplicate" | "concurrency-limit" | "approval-required"
    reclaimed?: boolean
  }>
  recordSkippedAgencyDispatch(
    tenantId: string,
    idempotencyKey: string,
    loopId: string,
    decision: AgencyDispatchDecision,
    now: string,
  ): Promise<void>
  finishAgencyDispatch(
    tenantId: string,
    idempotencyKey: string,
    reservationId: string,
    status: "dispatched" | "failed" | "dead-letter",
    now: string,
    runId?: string,
  ): Promise<void>
  createAgencyModelRun(
    tenantId: string,
    subjectType: AgencyRunDocument["subjectType"],
    subjectId: string,
    run: unknown,
    now: string,
  ): Promise<void>
  finishAgencyModelRun(tenantId: string, run: unknown, now: string): Promise<void>
  appendRunEvent(
    tenantId: string,
    runId: string,
    goalId: string | undefined,
    event: unknown,
    time: string,
  ): Promise<void>
  getManifest(tenantId: string, kind: string): Promise<{ doc: unknown; updatedAt: string } | null>
  saveReport(
    tenantId: string,
    slug: string,
    runId: string,
    title: string,
    body: string,
    meta: unknown,
    updatedAt: string,
  ): Promise<void>
  listIntents(tenantId: string): Promise<Array<{ intentId: string; intent: unknown; updatedAt: string }>>
  getIntent(
    tenantId: string,
    intentId: string,
  ): Promise<{ intentId: string; intent: unknown; updatedAt: string } | null>
  saveIntent(tenantId: string, intentId: string, intent: unknown, updatedAt: string): Promise<void>
  appendIntentDecision(tenantId: string, intentId: string, decision: unknown): Promise<void>
  listDefinitions(tenantId: string, kind: "agent" | "capability" | "goal"): Promise<DefinitionDocument[]>
  listWorkflows(tenantId: string): Promise<WorkflowDocument[]>
  getWorkflowRun(tenantId: string, workflowId: string, runId: string): Promise<{ state: unknown } | null>
  saveWorkflowRun(tenantId: string, workflowId: string, runId: string, state: unknown, updatedAt: string): Promise<void>
}

function requireTenant(tenantId: string): string {
  const value = tenantId.trim()
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) throw new Error("tenantId must be an owner/repository pair")
  return value
}

function requireChatTenant(tenantId: string): string {
  const value = tenantId.trim()
  return value === "global" ? value : requireTenant(value)
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} must not be empty`)
  return normalized
}

export function createStateBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  client?: StateBackendClient,
): StateBackend {
  let transport = client
  if (!transport && hasGitHubActionsIdentity(env)) transport = createKodyApiBackendClient(env)
  if (!transport) {
    const url = env.CONVEX_URL?.trim()
    const serviceKey = env.KODY_SERVICE_KEY?.trim()
    if (!url || !serviceKey) {
      throw new Error("GitHub Actions identity or direct Kody backend credentials are required")
    }
    transport = createConvexClientFromEnv(env) as ConvexHttpClient
  }
  return {
    async get(tenantId, taskKey, kind) {
      const result = await transport.query(anyApi.taskState.get, {
        tenantId: requireTenant(tenantId),
        taskKey: requireNonEmpty(taskKey, "taskKey"),
        kind: requireNonEmpty(kind, "kind"),
      })
      return (result as TaskDocument | null) ?? null
    },
    async save(tenantId, taskKey, kind, doc, expectedUpdatedAt) {
      await transport.mutation(anyApi.taskState.save, {
        tenantId: requireTenant(tenantId),
        taskKey: requireNonEmpty(taskKey, "taskKey"),
        kind: requireNonEmpty(kind, "kind"),
        doc,
        updatedAt: new Date().toISOString(),
        ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
      })
    },
    async getRepoDoc(tenantId, kind) {
      const result = await transport.query(anyApi.repoDocs.get, {
        tenantId: requireTenant(tenantId),
        kind: requireNonEmpty(kind, "kind"),
      })
      return (result as TaskDocument | null) ?? null
    },
    async listRepoDocs(tenantId, prefix) {
      const result = await transport.query(anyApi.repoDocs.listByPrefix, {
        tenantId: requireTenant(tenantId),
        prefix: requireNonEmpty(prefix, "prefix"),
      })
      return Array.isArray(result) ? (result as TaskDocument[]) : []
    },
    async saveRepoDoc(tenantId, kind, doc, expectedUpdatedAt) {
      await transport.mutation(anyApi.repoDocs.save, {
        tenantId: requireTenant(tenantId),
        kind: requireNonEmpty(kind, "kind"),
        doc,
        updatedAt: new Date().toISOString(),
        ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
      })
    },
    async getGoal(tenantId, goalId) {
      const result = await transport.query(anyApi.goals.get, {
        tenantId: requireTenant(tenantId),
        goalId: requireNonEmpty(goalId, "goalId"),
      })
      return (result as GoalDocument | null) ?? null
    },
    async listGoals(tenantId) {
      const result = await transport.query(anyApi.goals.list, { tenantId: requireTenant(tenantId) })
      return Array.isArray(result) ? (result as GoalDocument[]) : []
    },
    async saveGoal(tenantId, goalId, state, updatedAt, expectedUpdatedAt) {
      await transport.mutation(anyApi.goals.save, {
        tenantId: requireTenant(tenantId),
        goalId: requireNonEmpty(goalId, "goalId"),
        state,
        updatedAt,
        ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
      })
    },
    async appendDailyLog(tenantId, stream, date, entry) {
      await transport.mutation(anyApi.dailyLogs.append, {
        tenantId: requireTenant(tenantId),
        stream,
        date: requireNonEmpty(date, "date"),
        entry,
      })
    },
    async appendChatEvent(tenantId, sessionId, event) {
      await transport.mutation(anyApi.chatEvents.append, {
        tenantId: requireChatTenant(tenantId),
        sessionId: requireNonEmpty(sessionId, "sessionId"),
        event,
      })
    },
    async saveAgencyRun(tenantId, runId, subjectType, subjectId, run, updatedAt) {
      await transport.mutation(anyApi.agencyRuns.save, {
        tenantId: requireTenant(tenantId),
        runId: requireNonEmpty(runId, "runId"),
        subjectType,
        subjectId: requireNonEmpty(subjectId, "subjectId"),
        run,
        updatedAt,
      })
    },
    async listAgencyDefinitions(tenantId) {
      const result = await transport.query(anyApi.agencyModel.listDefinitions, {
        tenantId: requireTenant(tenantId),
      })
      return Array.isArray(result) ? (result as AgencyDefinitionDocument[]) : []
    },
    async getAgencyState(tenantId, definitionId) {
      const result = await transport.query(anyApi.agencyModel.getState, {
        tenantId: requireTenant(tenantId),
        definitionId: requireNonEmpty(definitionId, "definitionId"),
      })
      return (result as AgencyStateDocument | null) ?? null
    },
    async putAgencyState(tenantId, definitionId, kind, schemaVersion, data, updatedAt) {
      await transport.mutation(anyApi.agencyModel.putState, {
        tenantId: requireTenant(tenantId),
        definitionId: requireNonEmpty(definitionId, "definitionId"),
        kind,
        schemaVersion,
        data,
        updatedAt,
      })
    },
    async appendAgencyOutput(tenantId, recordId, schemaVersion, data) {
      await transport.mutation(anyApi.agencyModel.appendOutput, {
        tenantId: requireTenant(tenantId),
        envelope: {
          schemaVersion,
          recordId: requireNonEmpty(recordId, "recordId"),
          data,
        },
      })
    },
    async listAgencyOutputs(tenantId, runId) {
      const result = await transport.query(anyApi.agencyModel.listOutputs, {
        tenantId: requireTenant(tenantId),
        ...(runId ? { runId: requireNonEmpty(runId, "runId") } : {}),
      })
      return Array.isArray(result) ? (result as AgencyOutputDocument[]) : []
    },
    async reserveAgencyDispatch(tenantId, reservation) {
      const result = await transport.mutation(anyApi.agencyModel.reserveDispatch, {
        tenantId: requireTenant(tenantId),
        ...reservation,
        decision: serializeAgencyDispatchDecision(reservation.decision),
        idempotencyKey: requireNonEmpty(reservation.idempotencyKey, "idempotencyKey"),
        loopId: requireNonEmpty(reservation.loopId, "loopId"),
        reservationId: requireNonEmpty(reservation.reservationId, "reservationId"),
        correlationId: requireNonEmpty(reservation.correlationId, "correlationId"),
        policyHash: requireNonEmpty(reservation.policyHash, "policyHash"),
      })
      return result as {
        acquired: boolean
        dispatchId?: string
        reason?: "duplicate" | "concurrency-limit" | "approval-required"
        reclaimed?: boolean
      }
    },
    async recordSkippedAgencyDispatch(tenantId, idempotencyKey, loopId, decision, now) {
      await transport.mutation(anyApi.agencyModel.recordSkippedDispatch, {
        tenantId: requireTenant(tenantId),
        idempotencyKey: requireNonEmpty(idempotencyKey, "idempotencyKey"),
        loopId: requireNonEmpty(loopId, "loopId"),
        decision: serializeAgencyDispatchDecision(decision),
        now,
      })
    },
    async finishAgencyDispatch(tenantId, idempotencyKey, reservationId, status, now, runId) {
      await transport.mutation(anyApi.agencyModel.finishDispatch, {
        tenantId: requireTenant(tenantId),
        idempotencyKey: requireNonEmpty(idempotencyKey, "idempotencyKey"),
        reservationId: requireNonEmpty(reservationId, "reservationId"),
        status,
        now,
        ...(runId ? { runId: requireNonEmpty(runId, "runId") } : {}),
      })
    },
    async createAgencyModelRun(tenantId, subjectType, subjectId, run, now) {
      await transport.mutation(anyApi.agencyModel.createRunRecord, {
        tenantId: requireTenant(tenantId),
        subjectType,
        subjectId: requireNonEmpty(subjectId, "subjectId"),
        run,
        now,
      })
    },
    async finishAgencyModelRun(tenantId, run, now) {
      await transport.mutation(anyApi.agencyModel.finishRunRecord, {
        tenantId: requireTenant(tenantId),
        run,
        now,
      })
    },
    async appendRunEvent(tenantId, runId, goalId, event, time) {
      await transport.mutation(anyApi.runEvents.append, {
        tenantId: requireTenant(tenantId),
        runId: requireNonEmpty(runId, "runId"),
        ...(goalId ? { goalId: requireNonEmpty(goalId, "goalId") } : {}),
        event,
        time: requireNonEmpty(time, "time"),
      })
    },
    async getManifest(tenantId, kind) {
      const result = await transport.query(anyApi.manifests.get, {
        tenantId: requireTenant(tenantId),
        kind: requireNonEmpty(kind, "kind"),
      })
      return (result as { doc: unknown; updatedAt: string } | null) ?? null
    },
    async saveReport(tenantId, slug, runId, title, body, meta, updatedAt) {
      await transport.mutation(anyApi.reports.save, {
        tenantId: requireTenant(tenantId),
        slug: requireNonEmpty(slug, "slug"),
        runId: requireNonEmpty(runId, "runId"),
        title,
        body,
        meta,
        updatedAt,
      })
    },
    async listIntents(tenantId) {
      const result = await transport.query(anyApi.intents.list, { tenantId: requireTenant(tenantId) })
      return Array.isArray(result) ? (result as Array<{ intentId: string; intent: unknown; updatedAt: string }>) : []
    },
    async getIntent(tenantId, intentId) {
      const result = await transport.query(anyApi.intents.get, {
        tenantId: requireTenant(tenantId),
        intentId: requireNonEmpty(intentId, "intentId"),
      })
      return (result as { intentId: string; intent: unknown; updatedAt: string } | null) ?? null
    },
    async saveIntent(tenantId, intentId, intent, updatedAt) {
      await transport.mutation(anyApi.intents.save, {
        tenantId: requireTenant(tenantId),
        intentId: requireNonEmpty(intentId, "intentId"),
        intent,
        updatedAt,
      })
    },
    async appendIntentDecision(tenantId, intentId, decision) {
      await transport.mutation(anyApi.intents.appendDecision, {
        tenantId: requireTenant(tenantId),
        intentId: requireNonEmpty(intentId, "intentId"),
        decision,
      })
    },
    async listDefinitions(tenantId, kind) {
      const result = await transport.query(anyApi.definitions.listCurrent, {
        tenantId: requireTenant(tenantId),
        kind,
      })
      return Array.isArray(result) ? (result as DefinitionDocument[]) : []
    },
    async listWorkflows(tenantId) {
      const result = await transport.query(anyApi.workflows.list, {
        tenantId: requireTenant(tenantId),
      })
      return Array.isArray(result) ? (result as WorkflowDocument[]) : []
    },
    async getWorkflowRun(tenantId, workflowId, runId) {
      const result = await transport.query(anyApi.workflowRuns.get, {
        tenantId: requireTenant(tenantId),
        workflowId: requireNonEmpty(workflowId, "workflowId"),
        runId: requireNonEmpty(runId, "runId"),
      })
      return (result as { state: unknown } | null) ?? null
    },
    async saveWorkflowRun(tenantId, workflowId, runId, state, updatedAt) {
      await transport.mutation(anyApi.workflowRuns.save, {
        tenantId: requireTenant(tenantId),
        workflowId: requireNonEmpty(workflowId, "workflowId"),
        runId: requireNonEmpty(runId, "runId"),
        state,
        updatedAt,
      })
    },
  }
}

export function hasStateBackendConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasGitHubActionsIdentity(env) || Boolean(env.CONVEX_URL?.trim() && env.KODY_SERVICE_KEY?.trim())
}
