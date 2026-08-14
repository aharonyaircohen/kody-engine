import { type FunctionReference, getFunctionName } from "convex/server"
import type { StateBackendClient } from "./state-backend.js"

const DEFAULT_KODY_API_URL = "https://kody-dashboard-aguy.vercel.app"
const OIDC_AUDIENCE = "kody-api"
const WORKFLOW_COMPLETION_SUMMARY_MAX_LENGTH = 1_000

interface CachedToken {
  value: string
  expiresAt: number
}

let cachedToken: CachedToken | null = null

export function resolveKodyApiUrl(env: NodeJS.ProcessEnv): string {
  return (
    env.KODY_API_URL?.trim() ||
    env.KODY_DASHBOARD_URL?.trim() ||
    env.DASHBOARD_URL?.trim() ||
    DEFAULT_KODY_API_URL
  ).replace(/\/$/, "")
}

function oidcRequestUrl(env: NodeJS.ProcessEnv): URL {
  const raw = env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim()
  if (!raw) throw new Error("GitHub Actions OIDC request URL is unavailable")
  const url = new URL(raw)
  if (url.protocol !== "https:") throw new Error("GitHub Actions OIDC request URL must use HTTPS")
  url.searchParams.set("audience", OIDC_AUDIENCE)
  return url
}

function tokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      exp?: unknown
    }
    return typeof payload.exp === "number" ? payload.exp * 1000 : Date.now() + 4 * 60_000
  } catch {
    return Date.now() + 4 * 60_000
  }
}

async function githubOidcToken(env: NodeJS.ProcessEnv, force = false): Promise<string> {
  if (!force && cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.value
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim()
  if (!requestToken) throw new Error("GitHub Actions OIDC request token is unavailable")

  const response = await fetch(oidcRequestUrl(env), {
    headers: { Authorization: `Bearer ${requestToken}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`GitHub Actions identity request failed (${response.status})`)
  const body = (await response.json()) as { value?: unknown }
  if (typeof body.value !== "string" || !body.value) throw new Error("GitHub Actions identity response was invalid")
  cachedToken = { value: body.value, expiresAt: tokenExpiry(body.value) }
  return body.value
}

function operationName(fn: FunctionReference<"query"> | FunctionReference<"mutation">): string {
  return getFunctionName(fn).replace(":", ".")
}

async function callKodyApi(
  kind: "query" | "mutation",
  fn: FunctionReference<"query"> | FunctionReference<"mutation">,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const call = async (forceToken: boolean) => {
    const token = await githubOidcToken(env, forceToken)
    return fetch(`${resolveKodyApiUrl(env)}/api/kody/engine/backend`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ kind, operation: operationName(fn), args }),
      signal: AbortSignal.timeout(30_000),
    })
  }

  let response = await call(false)
  if (response.status === 401) response = await call(true)
  if (!response.ok) throw new Error(`Kody backend request failed (${response.status})`)
  const body = (await response.json()) as { result?: unknown }
  return body.result
}

export function hasGitHubActionsIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.GITHUB_ACTIONS === "true" &&
      env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim() &&
      env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim(),
  )
}

export function createKodyApiBackendClient(env: NodeJS.ProcessEnv = process.env): StateBackendClient {
  if (!hasGitHubActionsIdentity(env)) throw new Error("GitHub Actions workflow identity is unavailable")
  return {
    query: (fn, args) => callKodyApi("query", fn, args, env),
    mutation: (fn, args) => callKodyApi("mutation", fn, args, env),
  }
}

export interface WorkflowCompletedNotification {
  workflowId: string
  runId: string
  loopId?: string
  status: "success" | "failed" | "blocked"
  summary?: string
  output?: Record<string, unknown>
}

export async function notifyWorkflowCompleted(
  notification: WorkflowCompletedNotification,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const token = await githubOidcToken(env)
  const { summary: rawSummary, ...completion } = notification
  const summary = rawSummary?.trim()
  const response = await fetch(`${resolveKodyApiUrl(env)}/api/kody/engine/workflow-completed`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      ...completion,
      ...(summary ? { summary: summary.slice(0, WORKFLOW_COMPLETION_SUMMARY_MAX_LENGTH) } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Kody workflow completion request failed (${response.status})`)
}

export async function readRuntimeSecretFromKody(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const token = await githubOidcToken(env)
  const response = await fetch(`${resolveKodyApiUrl(env)}/api/kody/engine/secret`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Kody secret request failed (${response.status})`)
  const body = (await response.json()) as { value?: unknown }
  return typeof body.value === "string" ? body.value : null
}

export async function writeRuntimeSecretsToKody(
  secrets: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const token = await githubOidcToken(env)
  const response = await fetch(`${resolveKodyApiUrl(env)}/api/kody/engine/secret`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ secrets }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Kody secret upsert failed (${response.status})`)
}

export interface KodyPreviewContext {
  buildEnv: Record<string, string>
  buildMode: "dev" | "prod"
  flyApiToken: string | null
  flyOrgSlug: string | null
  flyRegion: string | null
  namespaceTenantId: string | null
  previewVerifyKey: string
}

export async function readPreviewContextFromKody(env: NodeJS.ProcessEnv = process.env): Promise<KodyPreviewContext> {
  const token = await githubOidcToken(env)
  const response = await fetch(`${resolveKodyApiUrl(env)}/api/kody/engine/preview-context`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Kody preview context request failed (${response.status})`)
  return (await response.json()) as KodyPreviewContext
}

export function resetKodyApiTokenForTests(): void {
  cachedToken = null
}
