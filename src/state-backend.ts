import type { FunctionReference } from "convex/server"
import { anyApi } from "convex/server"
import type { ConvexHttpClient } from "convex/browser"
import { createConvexClientFromEnv } from "./chat/convex-client.js"

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

export interface StateBackendClient {
  query: (fn: FunctionReference<"query">, args: Record<string, unknown>) => Promise<unknown>
  mutation: (fn: FunctionReference<"mutation">, args: Record<string, unknown>) => Promise<unknown>
}

export interface StateBackend {
  get(tenantId: string, taskKey: string, kind: string): Promise<TaskDocument | null>
  save(
    tenantId: string,
    taskKey: string,
    kind: string,
    doc: unknown,
    expectedUpdatedAt?: string,
  ): Promise<void>
  getRepoDoc(tenantId: string, kind: string): Promise<TaskDocument | null>
  listRepoDocs(tenantId: string, prefix: string): Promise<TaskDocument[]>
  saveRepoDoc(tenantId: string, kind: string, doc: unknown, expectedUpdatedAt?: string): Promise<void>
  getGoal(tenantId: string, goalId: string): Promise<GoalDocument | null>
  listGoals(tenantId: string): Promise<GoalDocument[]>
  saveGoal(tenantId: string, goalId: string, state: unknown, updatedAt: string, expectedUpdatedAt?: string): Promise<void>
  appendDailyLog(tenantId: string, stream: "activity" | "events" | "flyActivity", date: string, entry: unknown): Promise<void>
  saveReport(
    tenantId: string,
    slug: string,
    runId: string,
    title: string,
    body: string,
    meta: unknown,
    updatedAt: string,
  ): Promise<void>
}

function requireTenant(tenantId: string): string {
  const value = tenantId.trim()
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) throw new Error("tenantId must be an owner/repository pair")
  return value
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
  const url = env.CONVEX_URL?.trim()
  const serviceKey = env.KODY_SERVICE_KEY?.trim()
  if (!url || !serviceKey) throw new Error("CONVEX_URL and KODY_SERVICE_KEY are required")

  const transport = client ?? (createConvexClientFromEnv(env) as ConvexHttpClient)
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
  }
}
