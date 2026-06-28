/**
 * brainServe — preflight for the `brain-serve` executable.
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
 * Sessions are stored as JSONL at `<cwd>/.kody/sessions/<chatId>.jsonl`,
 * matching the existing chat loop. Use a Fly volume mount to persist them
 * across machine destroys.
 *
 * Sets ctx.skipAgent — never invokes the Kody agent through the executor.
 * The agent runs once per chat turn inside the HTTP handler.
 */

import * as fs from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import * as path from "node:path"
import type { ChatEvent, EventSink } from "../chat/events.js"
import { type ChatTurnOptions, type ChatTurnResult, runChatTurn } from "../chat/loop.js"
import { appendTurn, sessionFilePath } from "../chat/session.js"
import { LITELLM_DEFAULT_URL, needsLitellmProxy, parseProviderModel } from "../config.js"
import { unpackAllSecrets } from "../kody-cli.js"
import { type LitellmHandle, startLitellmIfNeeded } from "../litellm.js"
import { type CloneRepoFn, defaultCloneRepo, ensureRepoCwd } from "../repoWorkspace.js"
import { beginTurn, endTurnIfUnterminated, getLastSeq, subscribe } from "../scripts/brainTurnLog.js"

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
 * Validate a URL-supplied `chatId` before it reaches the filesystem. It flows
 * into `sessionFilePath`/`eventsPath` as `.kody/sessions/<chatId>.jsonl`; a
 * value like `../../../../tmp/evil` (URL-encoded `..%2F…`) would otherwise
 * create/append/read files outside the repo.
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

function envGithubToken(): string {
  return (process.env.KODY_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_PAT ?? "").trim()
}

function parseRepoSlug(repo: string | undefined): { owner: string; repo: string } | null {
  if (!repo) return null
  const [owner, name] = repo.split("/", 2)
  if (!owner || !name) return null
  return { owner, repo: name }
}

function streamStartupError(res: ServerResponse, dir: string, chatId: string, err: unknown): void {
  const sinceFloor = getLastSeq(dir, chatId)
  const emitToLog = beginTurn(dir, chatId)
  emitToLog({
    type: "error",
    chatId,
    error: err instanceof Error ? err.message : String(err),
  })
  streamToRes(res, dir, chatId, sinceFloor)
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
  ) {}

  async emit(event: ChatEvent): Promise<void> {
    const be = translateChatEvent(event, this.chatId)
    if (be) this.emitToLog(be)
  }
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
function streamToRes(res: ServerResponse, dir: string, chatId: string, since: number): void {
  writeSseHeaders(res)
  // Unsequenced handshake — confirms the chat id, ignored by cursor tracking.
  emitSse(res, { type: "chat", chatId })

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
  model: ReturnType<typeof parseProviderModel>
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
}

async function handleChatTurn(
  req: IncomingMessage,
  res: ServerResponse,
  chatId: string,
  opts: {
    cwd: string
    reposRoot: string
    cloneRepo: CloneRepoFn
    model: ReturnType<typeof parseProviderModel>
    litellmUrl: string | null
    runTurn: (opts: ChatTurnOptions) => Promise<ChatTurnResult>
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

  const stateToken = repoToken || envGithubToken()

  const sessionFile = sessionFilePath(opts.cwd, chatId)
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })

  appendTurn(sessionFile, {
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
  })

  // Cursor floor for this turn = the chat's last seq before it starts. The
  // turn runs detached (server-side, independent of this connection); this
  // response just tails it from the floor and can be reconnected via
  // GET /chats/:id/stream?since=<seq> after a Vercel-ceiling disconnect.
  const sinceFloor = getLastSeq(opts.cwd, chatId)
  const emitToLog = beginTurn(opts.cwd, chatId)
  const sink = new BrokerSink(emitToLog, chatId)

  void enqueue(chatId, async () => {
    try {
      // Per-repo working dir for the agent's code tools — clones on first use.
      // A clone/resolve failure surfaces as a chat.error via the catch below.
      const agentCwd = await ensureRepoCwd({
        baseCwd: opts.cwd,
        reposRoot: opts.reposRoot,
        repo,
        repoToken,
        cloneRepo: opts.cloneRepo,
      })
      await opts.runTurn({
        sessionId: chatId,
        sessionFile,
        cwd: agentCwd,
        model: opts.model,
        litellmUrl: opts.litellmUrl,
        sink,
        // Let the agent clone + work on OTHER repos via the fetch_repo tool.
        reposRoot: opts.reposRoot,
        repoToken,
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
      endTurnIfUnterminated(opts.cwd, chatId, errMsg)
    } finally {
      // runTurn normally emits its own done/error; this only fires if it
      // returned without a terminal event, so reconnecting clients never
      // hang waiting for an end that won't come.
      endTurnIfUnterminated(
        opts.cwd,
        chatId,
        "Brain turn ended without a reply (the machine may have restarted mid-turn) — please resend your message",
      )
    }
  })

  streamToRes(res, opts.cwd, chatId, sinceFloor)
}

/**
 * Build (but do not listen on) the HTTP server. Factored out for tests:
 * a test can call buildServer({ runTurn: fakeTurn }) and exercise the routes
 * against a real socket without booting LiteLLM.
 */
export function buildServer(opts: BuildServerOptions): Server {
  const runTurn = opts.runTurn ?? runChatTurn
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
  // brain-serve runs config-free (it serves many repos cloned per message), so
  // its model comes from the MODEL env var — same fallback the executor used
  // for this formerly-configless executable.
  const model = parseProviderModel(process.env.MODEL?.trim() || "claude/claude-haiku-4-5-20251001")
  const usesProxy = needsLitellmProxy(model)

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
