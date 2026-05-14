/**
 * brainServe — preflight for the `brain-serve` executable.
 *
 * Long-lived HTTP server that wraps the kody chat loop and speaks the Brain
 * SSE protocol. Pair with Kody-Dashboard's existing `/api/kody/chat/brain`
 * proxy so a Fly-hosted Brain alternative needs zero dashboard changes.
 *
 * Endpoints:
 *   POST /chats/:chatId/messages    — body { message }, returns SSE stream
 *   GET  /healthz                   — 200 ok
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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import * as fs from "node:fs"
import * as path from "node:path"

import { parseProviderModel, needsLitellmProxy, LITELLM_DEFAULT_URL } from "../config.js"
import type { PreflightScript } from "../executables/types.js"
import { type LitellmHandle, startLitellmIfNeeded } from "../litellm.js"
import { runChatTurn, type ChatTurnOptions, type ChatTurnResult } from "../chat/loop.js"
import type { ChatEvent, EventSink } from "../chat/events.js"
import { appendTurn, sessionFilePath } from "../chat/session.js"

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
    throw new Error(
      "BRAIN_API_KEY env var is required — set it on the Fly machine before boot.",
    )
  }
  return key
}

export function authOk(req: IncomingMessage, expected: string): boolean {
  const xApiKey = (req.headers["x-api-key"] as string | undefined)?.trim()
  if (xApiKey && xApiKey === expected) return true
  const auth = (req.headers["authorization"] as string | undefined)?.trim()
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
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

/**
 * Adapter sink — translates kody ChatEvents into Brain SSE events on the
 * response stream. `chat.thinking` is dropped (Brain protocol has no
 * dedicated thinking channel; the agent's final text reply is what matters).
 */
export class BrainSseSink implements EventSink {
  constructor(
    private readonly res: ServerResponse,
    private readonly chatId: string,
  ) {}

  async emit(event: ChatEvent): Promise<void> {
    switch (event.event) {
      case "chat.message": {
        const content = String(event.payload.content ?? "")
        if (content.length > 0) {
          emitSse(this.res, { type: "text", text: content, chatId: this.chatId })
        }
        return
      }
      case "chat.tool": {
        if (event.payload.phase !== "use") return
        emitSse(this.res, {
          type: "tool_use",
          name: typeof event.payload.name === "string" ? event.payload.name : "tool",
          input: event.payload.input ?? {},
          chatId: this.chatId,
        })
        return
      }
      case "chat.done": {
        emitSse(this.res, { type: "done", chatId: this.chatId })
        return
      }
      case "chat.error": {
        const errMsg =
          typeof event.payload.error === "string"
            ? event.payload.error
            : "agent error"
        emitSse(this.res, { type: "error", error: errMsg, chatId: this.chatId })
        return
      }
      // chat.thinking / chat.ready / chat.exit — not part of the Brain protocol.
      default:
        return
    }
  }
}

export interface BuildServerOptions {
  apiKey: string
  cwd: string
  model: ReturnType<typeof parseProviderModel>
  litellmUrl: string | null
  /** Seam for tests — defaults to the real chat-loop runChatTurn. */
  runTurn?: (opts: ChatTurnOptions) => Promise<ChatTurnResult>
}

async function handleChatTurn(
  req: IncomingMessage,
  res: ServerResponse,
  chatId: string,
  opts: {
    cwd: string
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
    typeof body === "object" && body !== null && "message" in body
      ? (body as { message?: unknown }).message
      : undefined

  if (typeof message !== "string" || !message.trim()) {
    sendJson(res, 400, { error: "message required" })
    return
  }

  const sessionFile = sessionFilePath(opts.cwd, chatId)
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })

  appendTurn(sessionFile, {
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
  })

  writeSseHeaders(res)
  emitSse(res, { type: "chat", chatId })

  const sink = new BrainSseSink(res, chatId)

  try {
    await opts.runTurn({
      sessionId: chatId,
      sessionFile,
      cwd: opts.cwd,
      model: opts.model,
      litellmUrl: opts.litellmUrl,
      sink,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[brain-serve] chat turn failed: ${errMsg}\n`)
    try {
      emitSse(res, { type: "error", error: errMsg, chatId })
    } catch {
      /* response may already be torn down */
    }
  } finally {
    try {
      res.end()
    } catch {
      /* best effort */
    }
  }
}

/**
 * Build (but do not listen on) the HTTP server. Factored out for tests:
 * a test can call buildServer({ runTurn: fakeTurn }) and exercise the routes
 * against a real socket without booting LiteLLM.
 */
export function buildServer(opts: BuildServerOptions): Server {
  const runTurn = opts.runTurn ?? runChatTurn
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
      if (!chatId) {
        sendJson(res, 400, { error: "chatId required" })
        return
      }
      await handleChatTurn(req, res, chatId, {
        cwd: opts.cwd,
        model: opts.model,
        litellmUrl: opts.litellmUrl,
        runTurn,
      })
      return
    }

    sendJson(res, 404, { error: "not found" })
  })
}

export const brainServe: PreflightScript = async (ctx) => {
  ctx.skipAgent = true

  const apiKey = getApiKey()
  const port = Number(process.env.PORT ?? DEFAULT_PORT)
  const model = parseProviderModel(ctx.config.agent.model)
  const usesProxy = needsLitellmProxy(model)

  let handle: LitellmHandle | null = null
  if (usesProxy) {
    process.stdout.write(
      `[brain-serve] starting LiteLLM proxy for ${model.provider}/${model.model}...\n`,
    )
    handle = await startLitellmIfNeeded(model, ctx.cwd)
    process.stdout.write(
      `[brain-serve] LiteLLM ready at ${handle?.url ?? LITELLM_DEFAULT_URL}\n`,
    )
  }
  const litellmUrl = usesProxy ? handle?.url ?? LITELLM_DEFAULT_URL : null

  const server = buildServer({
    apiKey,
    cwd: ctx.cwd,
    model,
    litellmUrl,
  })

  await new Promise<void>((resolve) => {
    server.listen(port, "0.0.0.0", () => {
      process.stdout.write(
        `[brain-serve] listening on 0.0.0.0:${port} (cwd=${ctx.cwd})\n`,
      )
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
}
