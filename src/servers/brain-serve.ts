/**
 * brainServe — preflight for the `brain-serve` implementation.
 *
 * Long-lived HTTP server that wraps the kody chat loop and speaks the Brain
 * SSE protocol. Pair with Kody-Dashboard's existing `/api/kody/chat/brain`
 * proxy so a Fly-hosted Brain alternative needs zero dashboard changes.
 *
 * Endpoints:
 *   POST /chats/:chatId/messages       — body { message }, returns SSE stream
 *   GET  /chats/:chatId/stream?since=N — reconnect: replay events after N then
 *                                        live-tail the running turn to its end
 *   GET  /healthz                      — 200 ok
 *
 * A turn runs to completion server-side regardless of the client connection;
 * every event after the handshake carries a per-chat monotonic `seq`. If the
 * connection drops mid-turn (e.g. the Vercel proxy's request-duration cap),
 * the client reconnects to /stream with the highest seq it saw.
 *
 * Auth: every request must carry `X-Api-Key: $BRAIN_API_KEY` (or
 * `Authorization: Bearer $BRAIN_API_KEY`). The key is set at machine boot —
 * the dashboard's Settings stores it alongside the URL.
 *
 * Sessions use disposable runtime JSONL caches, with the backend as the
 * durable authority so a replacement machine can restore chat state.
 *
 * Sets ctx.skipAgent — never invokes the Kody agent through the executor.
 * The agent runs once per chat turn inside the HTTP handler.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import * as path from "node:path"
import type { ChatEvent, EventSink } from "../chat/events.js"
import { type ChatTurnOptions, type ChatTurnResult, runChatTurn } from "../chat/loop.js"
import { resolveBrainDriver } from "../chat/runtime-drivers.js"
import { sessionFilePath } from "../chat/session.js"
import { createSessionStore, type SessionStore, type SessionStoreOptions } from "../chat/session-store.js"
import { LITELLM_DEFAULT_URL, needsLitellmProxy, type ProviderModel, parseModelRuntimeConfig } from "../config.js"
import { type DefinitionSource, hydrateDefinitions } from "../definition-hydration.js"
import { unpackAllSecrets } from "../kody-cli.js"
import { type LitellmHandle, startLitellmIfNeeded } from "../litellm.js"
import { type CloneRepoFn, defaultCloneRepo, ensureRepoCwd } from "../repoWorkspace.js"
import { beginTurn, endTurnIfUnterminated, getLastSeq, subscribe } from "../scripts/brainTurnLog.js"
import { createStateBackendFromEnv } from "../state-backend.js"

export interface BrainEvent {
  type: "chat" | "text" | "tool_use" | "done" | "error"
  chatId?: string
  text?: string
  name?: string
  input?: unknown
  error?: string
}

export const DEFAULT_PORT = 8080

function getApiKey(): string {
  const key = (process.env.BRAIN_API_KEY ?? "").trim()
  if (!key) {
    throw new Error("BRAIN_API_KEY env var is required — set it on the Fly machine before boot.")
  }
  return key
}

/**
 * Validate a URL-supplied `chatId` before it reaches local cache/state paths.
 * A value like `../../../../tmp/evil` (URL-encoded `..%2F…`) would otherwise
 * create/append/read files outside the intended per-chat location.
 *
 * chatIds are legitimately multi-segment (e.g. `user/alice/chat-1`, arriving
 * URL-encoded), so `/` is allowed and maps to nested dirs under the sessions
 * root. The only escape vector is `..`, so reject any `.`/`..`/empty path
 * segment, a leading slash (absolute), backslashes, and out-of-charset chars.
 */
export function isSafeChatId(id: string): boolean {
  if (!id || id.length > 200) return false
  if (id.startsWith("/") || id.includes("\\")) return false
  if (/[^a-zA-Z0-9._/-]/.test(id)) return false
  return id.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..")
}

export function authOk(req: IncomingMessage, expected: string): boolean {
  const xApiKey = (req.headers["x-api-key"] as string | undefined)?.trim()
  if (xApiKey && xApiKey === expected) return true
  const auth = (req.headers.authorization as string | undefined)?.trim()
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() === expected
  }
  return false
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8")
      if (!raw.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    req.on("error", reject)
  })
}

/** Pull a non-empty trimmed string field from a parsed JSON body, else undefined. */
function strField(body: unknown, key: string): string | undefined {
  if (typeof body === "object" && body !== null && key in body) {
    const v = (body as Record<string, unknown>)[key]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return undefined
}

/** Pull a boolean field from a parsed JSON body, else false. */
function boolField(body: unknown, key: string): boolean {
  return typeof body === "object" && body !== null && (body as Record<string, unknown>)[key] === true
}

function agentIdentityField(body: unknown): ChatTurnOptions["agentIdentity"] | undefined {
  if (typeof body !== "object" || body === null || !("agentIdentity" in body)) return undefined
  const value = (body as Record<string, unknown>).agentIdentity
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const slug = typeof record.slug === "string" ? record.slug.trim() : ""
  const bodyText = typeof record.body === "string" ? record.body.trim() : ""
  if (!slug || !bodyText) return undefined
  return { slug, body: bodyText }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
}

function emitSse(res: ServerResponse, event: BrainEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function openSseStream(res: ServerResponse, chatId: string): void {
  writeSseHeaders(res)
  emitSse(res, { type: "chat", chatId })
}

function envGithubToken(): string {
  return (process.env.KODY_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_PAT ?? "").trim()
}

/**
 * Pure translation: kody ChatEvent → Brain SSE event, or null when the event
 * has no Brain-protocol equivalent (chat.thinking / chat.ready / chat.exit,
 * empty chat.message, chat.tool result phase).
 */
export function translateChatEvent(event: ChatEvent, chatId: string): BrainEvent | null {
  switch (event.event) {
    case "chat.message": {
      const content = String(event.payload.content ?? "")
      if (content.length === 0) return null
      return { type: "text", text: content, chatId }
    }
    case "chat.tool": {
      if (event.payload.phase !== "use") return null
      return {
        type: "tool_use",
        name: typeof event.payload.name === "string" ? event.payload.name : "tool",
        input: event.payload.input ?? {},
        chatId,
      }
    }
    case "chat.done":
      return { type: "done", chatId }
    case "chat.error":
      return {
        type: "error",
        error: typeof event.payload.error === "string" ? event.payload.error : "agent error",
        chatId,
      }
    default:
      return null
  }
}

/**
 * Adapter sink — translates kody ChatEvents into Brain SSE events on the
 * response stream. Kept for direct/unit use; the live request path uses
 * BrokerSink so a turn survives a disconnected client.
 */
export class BrainSseSink implements EventSink {
  constructor(
    private readonly res: ServerResponse,
    private readonly chatId: string,
  ) {}

  async emit(event: ChatEvent): Promise<void> {
    const be = translateChatEvent(event, this.chatId)
    if (be) emitSse(this.res, be)
  }
}

/**
 * Sink that feeds the turn broker instead of a response. The turn runs to
 * completion server-side; the broker sequences + persists every event and
 * fans it out to whichever SSE connection is currently attached (or replays
 * it on reconnect).
 */
export class BrokerSink implements EventSink {
  constructor(
    private readonly emitToLog: (event: BrainEvent) => void,
    private readonly chatId: string,
    private readonly tenantId?: string,
  ) {}

  async emit(event: ChatEvent): Promise<void> {
    const be = translateChatEvent(event, this.chatId)
    if (!be) return
    this.emitToLog(be)
    // Local Brain runs without Convex. The broker log remains the local
    // source of truth in that mode; only mirror events remotely when the
    // durable backend is actually configured.
    if (this.tenantId && hasStateBackendConfig()) {
      await createStateBackendFromEnv().appendChatEvent(this.tenantId, this.chatId, be)
    }
  }
}

export function hasStateBackendConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CONVEX_URL?.trim() && env.KODY_SERVICE_KEY?.trim())
}

const definitionHydrations = new Map<string, Promise<void>>()

export async function hydrateBrainDefinitions(options: {
  cwd: string
  repo: string | undefined
  env?: NodeJS.ProcessEnv
  backend?: DefinitionSource
}): Promise<void> {
  const env = options.env ?? process.env
  if (!options.repo || !hasStateBackendConfig(env)) return

  const key = `${options.cwd}\0${options.repo}`
  const running = definitionHydrations.get(key)
  if (running) return running

  const hydration = hydrateDefinitions({
    cwd: options.cwd,
    tenantId: options.repo,
    backend: options.backend ?? createStateBackendFromEnv(env),
  })
    .then(() => undefined)
    .finally(() => {
      if (definitionHydrations.get(key) === hydration) {
        definitionHydrations.delete(key)
      }
    })
  definitionHydrations.set(key, hydration)
  return hydration
}

// Per-chat turn serialization — a chat's turns must not interleave (shared
// session JSONL + worktree). Mirrors the VPS brain's enqueue().
const chatQueues = new Map<string, Promise<unknown>>()

function enqueue(chatId: string, fn: () => Promise<unknown>): Promise<unknown> {
  const prev = chatQueues.get(chatId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  chatQueues.set(
    chatId,
    next.finally(() => {
      if (chatQueues.get(chatId) === next) chatQueues.delete(chatId)
    }),
  )
  return next
}

/**
 * Stream a chat's events to an SSE response starting after `since`, replaying
 * the persisted gap then live-tailing until the turn's terminal event. The
 * turn keeps running even if this response disconnects. Every event after the
 * handshake carries its `seq` so the client can reconnect from it.
 */
function streamToRes(
  res: ServerResponse,
  dir: string,
  chatId: string,
  since: number,
  opts: { opened?: boolean } = {},
): void {
  if (!opts.opened) {
    // Unsequenced handshake — confirms the chat id, ignored by cursor tracking.
    openSseStream(res, chatId)
  }
  let maxSent = since
  const unsubscribe = subscribe(
    dir,
    chatId,
    since,
    (rec) => {
      if (rec.seq <= maxSent) return // dedupe backlog↔live boundary
      maxSent = rec.seq
      if (res.writableEnded) return
      res.write(`data: ${JSON.stringify({ ...rec.event, seq: rec.seq })}\n\n`)
    },
    () => {
      if (!res.writableEnded) {
        try {
          res.end()
        } catch {
          /* best effort */
        }
      }
    },
  )
  res.on("close", unsubscribe)
}

// Multi-repo workspace helpers (ensureRepoCwd / defaultCloneRepo / CloneRepoFn)
// live in ../repoWorkspace.ts, shared with the fetch_repo chat tool. Re-export
// ensureRepoCwd here so the existing brain-serve test suite keeps importing it
// from this module.
export { ensureRepoCwd }

export interface BuildServerOptions {
  apiKey: string
  cwd: string
  model: ProviderModel
  litellmUrl: string | null
  /**
   * Root under which per-repo clones live (`<reposRoot>/<owner>/<name>`).
   * Defaults to a `repos` sibling of `cwd` (so a boot `cwd` of
   * `/workspace/repo` → `/workspace/repos`).
   */
  reposRoot?: string
  /** Seam for tests — defaults to a real shallow `git clone`. */
  cloneRepo?: CloneRepoFn
  /** Seam for tests — defaults to the real chat-loop runChatTurn. */
  runTurn?: (opts: ChatTurnOptions) => Promise<ChatTurnResult>
  /** Seam for tests — production always uses the canonical Convex store. */
  createStore?: (opts: SessionStoreOptions) => SessionStore
  /** Brain response driver. Codex uses the user's local subscription login. */
  driver?: ChatTurnOptions["driver"]
}

async function handleChatTurn(
  req: IncomingMessage,
  res: ServerResponse,
  chatId: string,
  opts: {
    cwd: string
    reposRoot: string
    cloneRepo: CloneRepoFn
    model: ProviderModel
    litellmUrl: string | null
    runTurn: (opts: ChatTurnOptions) => Promise<ChatTurnResult>
    createStore: (opts: SessionStoreOptions) => SessionStore
    driver?: ChatTurnOptions["driver"]
  },
): Promise<void> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" })
    return
  }

  const message =
    typeof body === "object" && body !== null && "message" in body ? (body as { message?: unknown }).message : undefined

  if (typeof message !== "string" || !message.trim()) {
    sendJson(res, 400, { error: "message required" })
    return
  }

  // Which repo this turn runs against (owner/name) + a clone token. Both are
  // forwarded by the dashboard's brain-proxy; absent for a single-repo Brain.
  const repo = strField(body, "repo")
  const repoToken = strField(body, "repoToken")
  const dashboardUrl = strField(body, "dashboardUrl")
  const storeRepoUrl = strField(body, "storeRepoUrl")
  const storeRef = strField(body, "storeRef")
  const runtime = strField(body, "runtime")
  const conversationId = strField(body, "conversationId") || chatId
  const allowCrossRepo = boolField(body, "allowCrossRepo")
  const agentIdentity = agentIdentityField(body)

  let turnDriver = opts.driver
  if (runtime) {
    try {
      turnDriver = resolveBrainDriver(runtime)
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
      return
    }
  }

  // Open the stream before repo clone/state restore. First Repo Brain turns can
  // spend a while preparing the workspace; the browser should not wait for that
  // before it knows Brain accepted the message.
  openSseStream(res, chatId)
  if (repo) {
    emitSse(res, {
      type: "tool_use",
      chatId,
      name: "prepare_repo",
      input: { repo },
    })
  }

  let agentCwd: string
  try {
    agentCwd = await ensureRepoCwd({
      baseCwd: opts.cwd,
      reposRoot: opts.reposRoot,
      repo,
      repoToken,
      cloneRepo: opts.cloneRepo,
    })
  } catch (err) {
    emitSse(res, {
      type: "error",
      chatId,
      error: err instanceof Error ? err.message : String(err),
    })
    res.end()
    return
  }

  try {
    await hydrateBrainDefinitions({ cwd: agentCwd, repo })
  } catch (err) {
    emitSse(res, {
      type: "error",
      chatId,
      error: `Definition hydration failed: ${err instanceof Error ? err.message : String(err)}`,
    })
    res.end()
    return
  }

  const stateToken = repoToken || envGithubToken()
  const sessionFile = sessionFilePath(agentCwd, chatId)
  const sessionStore = opts.createStore({
    sessionId: conversationId,
    sessionFile,
    ...(repo ? { tenantId: repo } : {}),
  })
  await sessionStore.appendTurn({
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
  })

  // Cursor floor for this turn = the chat's last seq before it starts. The
  // turn runs detached (server-side, independent of this connection); this
  // response just tails it from the floor and can be reconnected via
  // GET /chats/:id/stream?since=<seq> after a Vercel-ceiling disconnect.
  const sinceFloor = getLastSeq(agentCwd, chatId)
  const emitToLog = beginTurn(agentCwd, chatId)
  const sink = new BrokerSink(emitToLog, chatId, repo)

  void enqueue(chatId, async () => {
    try {
      await opts.runTurn({
        sessionId: chatId,
        sessionFile,
        cwd: agentCwd,
        model: opts.model,
        litellmUrl: opts.litellmUrl,
        sink,
        store: sessionStore,
        reposRoot: opts.reposRoot,
        // Repo Brain is selected-repo focused by default. Higher-level
        // coordinator flows can opt into fetch_repo explicitly.
        ...(allowCrossRepo ? { enableFetchRepoTool: true } : {}),
        repoToken,
        ...(agentIdentity ? { agentIdentity } : {}),
        ...(turnDriver ? { driver: turnDriver } : {}),
        ...(dashboardUrl && repo && stateToken
          ? {
              cmsDashboardUrl: dashboardUrl,
              cmsRepoSlug: repo,
              cmsToken: stateToken,
              cmsStoreRepoUrl: storeRepoUrl,
              cmsStoreRef: storeRef,
            }
          : {}),
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[brain-serve] chat turn failed: ${errMsg}\n`)
      endTurnIfUnterminated(agentCwd, chatId, errMsg)
    } finally {
      // runTurn normally emits its own done/error; this only fires if it
      // returned without a terminal event, so reconnecting clients never
      // hang waiting for an end that won't come.
      endTurnIfUnterminated(
        agentCwd,
        chatId,
        "Brain turn ended without a reply (the machine may have restarted mid-turn) — please resend your message",
      )
    }
  })

  streamToRes(res, agentCwd, chatId, sinceFloor, { opened: true })
}

/**
 * Build (but do not listen on) the HTTP server. Factored out for tests:
 * a test can call buildServer({ runTurn: fakeTurn }) and exercise the routes
 * against a real socket without booting LiteLLM.
 */
export function buildServer(opts: BuildServerOptions): Server {
  const runTurn = opts.runTurn ?? runChatTurn
  const createStore = opts.createStore ?? createSessionStore
  const cloneRepo = opts.cloneRepo ?? defaultCloneRepo
  const reposRoot = opts.reposRoot ?? path.join(path.dirname(path.resolve(opts.cwd)), "repos")
  return createServer(async (req, res) => {
    if (!req.method || !req.url) {
      sendJson(res, 400, { error: "bad request" })
      return
    }

    const url = new URL(req.url, `http://localhost`)

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true })
      return
    }

    if (!authOk(req, opts.apiKey)) {
      sendJson(res, 401, { error: "unauthorized" })
      return
    }

    const m = url.pathname.match(/^\/chats\/([^/]+)\/messages\/?$/)
    if (req.method === "POST" && m) {
      const chatId = decodeURIComponent(m[1] ?? "")
      if (!chatId || !isSafeChatId(chatId)) {
        sendJson(res, 400, { error: "invalid chatId" })
        return
      }
      await handleChatTurn(req, res, chatId, {
        cwd: opts.cwd,
        reposRoot,
        cloneRepo,
        model: opts.model,
        litellmUrl: opts.litellmUrl,
        runTurn,
        createStore,
        driver: opts.driver,
      })
      return
    }

    // Reconnect/resume: replay events after ?since then live-tail the running
    // turn until it ends. This is what lets a Brain reply outlive the
    // dashboard's ~300s Vercel ceiling — the browser reconnects here with its
    // last-seen seq instead of losing the turn.
    const sm = url.pathname.match(/^\/chats\/([^/]+)\/stream\/?$/)
    if (req.method === "GET" && sm) {
      const chatId = decodeURIComponent(sm[1] ?? "")
      if (!chatId || !isSafeChatId(chatId)) {
        sendJson(res, 400, { error: "invalid chatId" })
        return
      }
      const sinceRaw = url.searchParams.get("since")
      const since = Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : 0
      streamToRes(res, opts.cwd, chatId, since)
      return
    }

    sendJson(res, 404, { error: "not found" })
  })
}

export async function brainServe(opts: { cwd: string }): Promise<number> {
  // The dashboard ships the per-repo secrets vault to this machine as a
  // JSON ALL_SECRETS env var (see Kody-Dashboard fly-context/brain-fly).
  // Spread it into process.env so the chat agent's tools and the LiteLLM
  // proxy see provider keys — mirrors chat-cli's boot. BRAIN_API_KEY and
  // any machine-level env already set win (unpack skips existing keys).
  const unpacked = unpackAllSecrets()
  if (unpacked > 0) {
    process.stdout.write(`[brain-serve] unpacked ${unpacked} secret(s) from ALL_SECRETS\n`)
  }

  const apiKey = getApiKey()
  const port = Number(process.env.PORT ?? DEFAULT_PORT)
  const driver: ChatTurnOptions["driver"] =
    process.env.BRAIN_DRIVER?.trim() === "codex-app-server" ? "codex-app-server" : "native"
  // brain-serve runs config-free (it serves many repos cloned per message), so
  // its model comes from the MODEL env var — same fallback the executor used
  // for this formerly-configless implementation.
  const model = parseModelRuntimeConfig(
    process.env.MODEL?.trim() || "claude/claude-haiku-4-5-20251001",
    process.env.KODY_MODEL_CONFIG,
  )
  const usesProxy = driver === "native" && needsLitellmProxy(model)

  let handle: LitellmHandle | null = null
  if (usesProxy) {
    process.stdout.write(`[brain-serve] starting LiteLLM proxy for ${model.provider}/${model.model}...\n`)
    handle = await startLitellmIfNeeded(model, opts.cwd)
    process.stdout.write(`[brain-serve] LiteLLM ready at ${handle?.url ?? LITELLM_DEFAULT_URL}\n`)
  }
  const litellmUrl = usesProxy ? (handle?.url ?? LITELLM_DEFAULT_URL) : null

  const server = buildServer({
    apiKey,
    cwd: opts.cwd,
    // Per-repo clones live here; defaults to a `repos` sibling of cwd.
    reposRoot: process.env.BRAIN_REPOS_ROOT?.trim() || undefined,
    model,
    litellmUrl,
    driver,
  })

  await new Promise<void>((resolve) => {
    server.listen(port, "0.0.0.0", () => {
      process.stdout.write(`[brain-serve] listening on 0.0.0.0:${port} (cwd=${opts.cwd})\n`)
      resolve()
    })
  })

  const shutdown = (signal: string) => {
    process.stdout.write(`[brain-serve] ${signal} — shutting down\n`)
    server.close(() => {
      if (handle) {
        try {
          handle.kill()
        } catch {
          /* best effort */
        }
      }
      process.exit(0)
    })
  }
  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))

  // Block forever — the executor would otherwise return and exit the process.
  await new Promise<void>(() => {
    /* never resolves */
  })
  return 0 // unreachable; satisfies the Promise<number> return type
}
