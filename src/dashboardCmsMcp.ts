import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk"
import type { ZodRawShape } from "zod"
import { z } from "zod"

export interface DashboardCmsMcpHandle {
  server: McpSdkServerConfigWithInstance
}

export interface DashboardCmsMcpOptions {
  /** Repo slug "owner/name" forwarded to Dashboard CMS auth headers. */
  repoSlug: string
  /** Dashboard origin. Falls back to KODY_CMS_DASHBOARD_URL / KODY_DASHBOARD_URL / DASHBOARD_URL. */
  dashboardUrl?: string
  /** Dashboard auth token. Falls back to KODY_CMS_TOKEN / KODY_DASHBOARD_TOKEN / KODY_TOKEN / GitHub token env. */
  token?: string
  /** Dashboard store repo URL used by Dashboard to load CMS adapter code. */
  storeRepoUrl?: string
  /** Dashboard store ref used by Dashboard to load CMS adapter code. */
  storeRef?: string
  /** Optional caller-owned write gate. Return a refusal message to block writes. */
  assertWriteAllowed?: () => string | null | undefined
}

type CmsToolResult =
  | {
      ok: true
      status?: number
      data?: unknown
    }
  | {
      ok: false
      status?: number
      data?: unknown
      error?: string
      message?: string
    }

type CmsHeaderResult = { ok: true; headers: Record<string, string> } | Extract<CmsToolResult, { ok: false }>

export type DashboardCmsToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}>

export interface DashboardCmsToolDefinition {
  name: string
  description: string
  inputSchema: ZodRawShape
  handler: DashboardCmsToolHandler
}

function dashboardBaseUrl(opts: DashboardCmsMcpOptions): string | null {
  const raw =
    opts.dashboardUrl?.trim() ||
    process.env.KODY_CMS_DASHBOARD_URL?.trim() ||
    process.env.KODY_DASHBOARD_URL?.trim() ||
    process.env.DASHBOARD_URL?.trim() ||
    ""
  if (!raw) return null
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

function dashboardCmsToken(opts: DashboardCmsMcpOptions): string | null {
  return (
    opts.token?.trim() ||
    process.env.KODY_CMS_TOKEN?.trim() ||
    process.env.KODY_DASHBOARD_TOKEN?.trim() ||
    process.env.KODY_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_PAT?.trim() ||
    null
  )
}

function cmsHeaders(opts: DashboardCmsMcpOptions): CmsHeaderResult {
  const token = dashboardCmsToken(opts)
  const [owner, repo] = opts.repoSlug.split("/")
  if (!token) {
    return {
      ok: false,
      error: "missing_cms_token",
      message: "Set KODY_CMS_TOKEN, KODY_DASHBOARD_TOKEN, KODY_TOKEN, GH_TOKEN, GITHUB_TOKEN, or GH_PAT.",
    }
  }
  if (!owner || !repo) {
    return { ok: false, error: "invalid_repo", message: `Invalid repo slug: ${opts.repoSlug}` }
  }
  return {
    ok: true,
    headers: {
      "Content-Type": "application/json",
      "x-kody-token": token,
      "x-kody-owner": owner,
      "x-kody-repo": repo,
      ...(opts.storeRepoUrl?.trim() ? { "x-kody-store-repo-url": opts.storeRepoUrl.trim() } : {}),
      ...(opts.storeRef?.trim() ? { "x-kody-store-ref": opts.storeRef.trim() } : {}),
    },
  }
}

async function callDashboardCms(
  opts: DashboardCmsMcpOptions,
  path: string,
  init: RequestInit = {},
): Promise<CmsToolResult> {
  const baseUrl = dashboardBaseUrl(opts)
  if (!baseUrl) {
    return {
      ok: false,
      error: "missing_dashboard_url",
      message: "Set KODY_CMS_DASHBOARD_URL or KODY_DASHBOARD_URL to the Dashboard origin.",
    }
  }
  const headerResult = cmsHeaders(opts)
  if (!headerResult.ok) return headerResult

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...headerResult.headers,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
    const contentType = res.headers.get("content-type") ?? ""
    const data = contentType.includes("application/json")
      ? ((await res.json().catch(() => null)) as unknown)
      : await res.text().catch(() => "")
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: stringFieldFromRecord(data, "error") ?? "cms_request_failed",
        message: stringFieldFromRecord(data, "message") ?? `Dashboard CMS request failed with ${res.status}.`,
        data,
      }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    return {
      ok: false,
      error: "cms_request_error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

function cmsToolResponse(result: CmsToolResult): Awaited<ReturnType<DashboardCmsToolHandler>> {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    ...(result.ok ? {} : { isError: true }),
  }
}

function cmsQuery(args: Record<string, unknown>): string {
  const params = new URLSearchParams()
  const q = stringArg(args.q)
  if (q) params.set("q", q)
  const limit = numberArg(args.limit)
  if (limit !== undefined) params.set("limit", String(limit))
  const offset = numberArg(args.offset)
  if (offset !== undefined) params.set("offset", String(offset))
  if (args.filters && typeof args.filters === "object" && !Array.isArray(args.filters)) {
    params.set("filters", JSON.stringify(args.filters))
  }
  if (Array.isArray(args.sort)) {
    const sort = args.sort
      .flatMap((entry) => {
        if (!entry || typeof entry !== "object") return []
        const field = stringArg((entry as Record<string, unknown>).field)
        if (!field) return []
        const direction = (entry as Record<string, unknown>).direction === "asc" ? "asc" : "desc"
        return [`${field}:${direction}`]
      })
      .join(",")
    if (sort) params.set("sort", sort)
  }
  const value = params.toString()
  return value ? `?${value}` : ""
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function numberArg(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function documentArg(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function normalizeCmsDocumentIdInput(input: string): string {
  const trimmed = stripWrappingQuotes(input.trim())
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? trimmed
  const path = parseDocumentPath(withoutQuery)
  return path ?? parseDocumentIdSegment(withoutQuery) ?? withoutQuery
}

function stripWrappingQuotes(value: string): string {
  let current = value
  for (;;) {
    const next = current.replace(/^[`'"]+|[`'"]+$/g, "").trim()
    if (next === current) return current
    current = next
  }
}

function parseDocumentPath(value: string): string | null {
  const path = value.startsWith("http://") || value.startsWith("https://") ? urlPathname(value) : value
  if (!path?.includes("/content/entries/")) return null

  const parts = path.split("/").filter(Boolean).map(decodePathPart)
  const entriesIndex = parts.findIndex((part, index) => part === "content" && parts[index + 1] === "entries")
  const idPart = parts[entriesIndex + 3]
  if (!idPart || idPart === "new") return null
  return idPart === "edit" ? (parts[entriesIndex + 2] ?? null) : idPart
}

function parseDocumentIdSegment(value: string): string | null {
  const parts = value.split("/").filter(Boolean).map(decodePathPart)
  if (parts.length < 2) return null
  const lastPart = parts[parts.length - 1]
  if (!lastPart || lastPart === "new") return null
  return lastPart === "edit" ? (parts[parts.length - 2] ?? null) : lastPart
}

function urlPathname(value: string): string | null {
  try {
    return new URL(value).pathname
  } catch {
    return null
  }
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function stringFieldFromRecord(value: unknown, field: string): string | undefined {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[field] === "string"
    ? String((value as Record<string, unknown>)[field])
    : undefined
}

export function dashboardCmsToolDefinitions(opts: DashboardCmsMcpOptions): DashboardCmsToolDefinition[] {
  const cmsListCollectionsTool: DashboardCmsToolDefinition = {
    name: "cms_list_collections",
    description: "List configured Dashboard CMS collections and their supported operations. Read-only.",
    inputSchema: {},
    handler: async () => cmsToolResponse(await callDashboardCms(opts, "/api/kody/cms")),
  }

  const cmsListDocumentsTool: DashboardCmsToolDefinition = {
    name: "cms_list_documents",
    description: "List or search Dashboard CMS documents from one configured collection. Read-only.",
    inputSchema: {
      collection: z.string().min(1).describe("CMS collection name."),
      q: z.string().optional().describe("Optional search query."),
      filters: z.record(z.string(), z.unknown()).optional().describe("Optional filter object keyed by field."),
      sort: z
        .array(
          z.object({
            field: z.string().min(1),
            direction: z.enum(["asc", "desc"]).default("desc"),
          }),
        )
        .optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    handler: async (args) => {
      const collection = encodeURIComponent(stringArg(args.collection))
      return cmsToolResponse(await callDashboardCms(opts, `/api/kody/cms/${collection}${cmsQuery(args)}`))
    },
  }

  const cmsGetDocumentTool: DashboardCmsToolDefinition = {
    name: "cms_get_document",
    description:
      "Get one Dashboard CMS document by collection and id. Use a raw id or the content entry URL copied from the Dashboard.",
    inputSchema: {
      collection: z.string().min(1).describe("CMS collection name."),
      id: z.string().min(1).describe("Document id. Use cmsDocumentId from cms_list_documents when available."),
    },
    handler: async (args) => {
      const collection = encodeURIComponent(stringArg(args.collection))
      const id = encodeURIComponent(normalizeCmsDocumentIdInput(stringArg(args.id)))
      return cmsToolResponse(await callDashboardCms(opts, `/api/kody/cms/${collection}/${id}`))
    },
  }

  const cmsCreateDocumentTool: DashboardCmsToolDefinition = {
    name: "cms_create_document",
    description:
      "Create one Dashboard CMS document when the caller allows writes and the CMS collection allows create.",
    inputSchema: {
      collection: z.string().min(1).describe("CMS collection name."),
      data: z.record(z.string(), z.unknown()).describe("Document fields to create."),
    },
    handler: async (args) => {
      const refusal = opts.assertWriteAllowed?.()
      if (refusal) return { content: [{ type: "text", text: refusal }] }
      const collection = encodeURIComponent(stringArg(args.collection))
      return cmsToolResponse(
        await callDashboardCms(opts, `/api/kody/cms/${collection}`, {
          method: "POST",
          body: JSON.stringify(documentArg(args.data)),
        }),
      )
    },
  }

  const cmsUpdateDocumentTool: DashboardCmsToolDefinition = {
    name: "cms_update_document",
    description:
      "Update one Dashboard CMS document when the caller allows writes and the CMS collection allows update.",
    inputSchema: {
      collection: z.string().min(1).describe("CMS collection name."),
      id: z.string().min(1).describe("Document id."),
      data: z.record(z.string(), z.unknown()).describe("Partial document fields to update."),
    },
    handler: async (args) => {
      const refusal = opts.assertWriteAllowed?.()
      if (refusal) return { content: [{ type: "text", text: refusal }] }
      const collection = encodeURIComponent(stringArg(args.collection))
      const id = encodeURIComponent(normalizeCmsDocumentIdInput(stringArg(args.id)))
      return cmsToolResponse(
        await callDashboardCms(opts, `/api/kody/cms/${collection}/${id}`, {
          method: "PATCH",
          body: JSON.stringify(documentArg(args.data)),
        }),
      )
    },
  }

  return [
    cmsListCollectionsTool,
    cmsListDocumentsTool,
    cmsGetDocumentTool,
    cmsCreateDocumentTool,
    cmsUpdateDocumentTool,
  ]
}

export function buildDashboardCmsMcpServer(opts: DashboardCmsMcpOptions): DashboardCmsMcpHandle {
  const tools = dashboardCmsToolDefinitions(opts).map((def) =>
    tool(def.name, def.description, def.inputSchema as Parameters<typeof tool>[2], async (args) =>
      def.handler(args as Record<string, unknown>),
    ),
  )

  return {
    server: createSdkMcpServer({
      name: "kody-cms",
      version: "0.1.0",
      tools,
    }),
  }
}

export const DASHBOARD_CMS_MCP_TOOL_NAMES = [
  "cms_list_collections",
  "cms_list_documents",
  "cms_get_document",
  "cms_create_document",
  "cms_update_document",
] as const
