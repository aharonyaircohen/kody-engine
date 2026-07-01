/**
 * brain-proxy.ts
 *
 * The brain proxy — lives in the engine (not the dashboard) and speaks the
 * Brain SSE protocol to clients. Internally, it routes to whichever backend
 * the user has selected:
 *
 *   - "brain-serve"  → pass-through to the engine's own brain-serve
 *   - "hermes"       → translate Brain→OpenAI, proxy to Hermes API server
 *
 * The dashboard no longer needs a proxy of its own — it talks to this server
 * directly, and the protocol translation happens here.
 *
 * Why it lives in the engine:
 *   1. The engine already owns the Brain SSE protocol (brain-serve.ts)
 *   2. The engine can ship the Brain↔OpenAI adapter as a tested library
 *   3. Co-located with the brain processes on the same Fly Machine
 *
 * Routes (all speak Brain SSE to the client):
 *   POST /chats/:id/messages   — submit a user message, stream Brain SSE
 *   GET  /chats/:id/stream?since=N  — replay + live-tail (proxied to backend)
 *   GET  /healthz              — health check (no auth)
 *
 * Selection:
 *   BRAIN_BACKEND=brain-serve (default) | hermes
 *   BRAIN_SERVE_URL=http://localhost:8080    (when backend=brain-serve)
 *   HERMES_URL=http://localhost:3000         (when backend=hermes)
 *   BRAIN_API_KEY=...                        (sent to backend as auth)
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { URL } from "node:url"
import { brainToOpenAIRequest, translateOpenAISseToBrain } from "./brain-protocol.js"
import { authOk, type BrainEvent, isSafeChatId } from "./brain-serve.js"

export type BrainBackend = "brain-serve" | "hermes"

export interface BrainProxyOptions {
  /** API key clients must send (X-Api-Key or Authorization: Bearer). */
  apiKey: string
  /** Which backend to route to. */
  backend: BrainBackend
  /** brain-serve URL (default: http://localhost:8080) — only used when backend=brain-serve. */
  brainServeUrl?: string
  /** Hermes URL (default: http://localhost:3000) — only used when backend=hermes. */
  hermesUrl?: string
  /** Model to use when forwarding to Hermes. */
  model?: string
  /** Test hook: override the upstream fetch (returns a Response). */
  __fetch?: typeof fetch
}

export interface BrainProxy {
  httpServer: Server
  port: number
  url: string
  stop: () => Promise<void>
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

const DEFAULT_BRAIN_SERVE_URL = "http://localhost:8080"
const DEFAULT_HERMES_URL = "http://localhost:3000"
const DEFAULT_MODEL = "anthropic/claude-sonnet-4"

function setSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })
}

function writeSseLine(res: ServerResponse, line: string): void {
  res.write(line)
}

/**
 * Build (but do not listen on) the brain proxy HTTP server. Factored out for
 * tests: pass a port of 0 to let the OS assign one, then call `listen()`.
 */
export function buildBrainProxy(opts: BrainProxyOptions): {
  httpServer: Server
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
} {
  const backend = opts.backend
  const brainServeUrl = opts.brainServeUrl ?? DEFAULT_BRAIN_SERVE_URL
  const hermesUrl = opts.hermesUrl ?? DEFAULT_HERMES_URL
  const model = opts.model ?? DEFAULT_MODEL
  const doFetch = opts.__fetch ?? fetch

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Health check — no auth.
    if (req.url === "/healthz" || req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, backend }))
      return
    }

    // Auth — every other route requires the key.
    if (!authOk(req, opts.apiKey)) {
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "unauthorized" }))
      return
    }

    // Parse the URL to extract chatId.
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    const segments = url.pathname.split("/").filter(Boolean)

    // POST /chats/:id/messages
    if (req.method === "POST" && segments[0] === "chats" && segments[2] === "messages" && segments[1]) {
      const chatIdRaw = decodeURIComponent(segments[1])
      if (!isSafeChatId(chatIdRaw)) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "invalid chatId" }))
        return
      }
      // Read the request body.
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      let body: {
        message?: string
        repo?: string
        repoToken?: string
        dashboardUrl?: string
        storeRepoUrl?: string
        storeRef?: string
        allowCrossRepo?: boolean
      } = {}
      try {
        const raw = Buffer.concat(chunks).toString("utf-8")
        if (raw) body = JSON.parse(raw)
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "invalid JSON body" }))
        return
      }
      if (typeof body.message !== "string" || body.message.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "missing 'message' field" }))
        return
      }

      if (backend === "brain-serve") {
        await proxyToBrainServe({ req, res, brainServeUrl, apiKey: opts.apiKey, chatId: chatIdRaw, body, doFetch })
      } else {
        await proxyToHermes({
          res,
          hermesUrl,
          apiKey: opts.apiKey,
          chatId: chatIdRaw,
          message: body.message,
          model,
          doFetch,
        })
      }
      return
    }

    // GET /chats/:id/stream?since=N
    if (req.method === "GET" && segments[0] === "chats" && segments[2] === "stream" && segments[1]) {
      const chatIdRaw = decodeURIComponent(segments[1])
      if (!isSafeChatId(chatIdRaw)) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "invalid chatId" }))
        return
      }
      const since = Number(url.searchParams.get("since") ?? "0")
      // For now, only brain-serve supports ?since=. Hermes has no cursor
      // replay — the client would have to use OpenAI conversation_history
      // continuation. This is the documented gap.
      if (backend === "hermes") {
        res.writeHead(501, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            error:
              "reconnect not supported on hermes backend — Hermes has no cursor replay; client must use conversation_history continuation",
          }),
        )
        return
      }
      await proxyStreamToBrainServe({ req, res, brainServeUrl, apiKey: opts.apiKey, chatId: chatIdRaw, since, doFetch })
      return
    }

    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "not found" }))
  }

  const httpServer = createServer((req, res) => {
    void handler(req, res)
  })

  return { httpServer, handler }
}

interface ProxyToBrainServeArgs {
  req: IncomingMessage
  res: ServerResponse
  brainServeUrl: string
  apiKey: string
  chatId: string
  body: {
    message?: string
    repo?: string
    repoToken?: string
    dashboardUrl?: string
    storeRepoUrl?: string
    storeRef?: string
    allowCrossRepo?: boolean
  }
  doFetch: typeof fetch
}

async function proxyToBrainServe(args: ProxyToBrainServeArgs): Promise<void> {
  const url = `${args.brainServeUrl.replace(/\/$/, "")}/chats/${encodeURIComponent(args.chatId)}/messages`
  const upstream = await args.doFetch(url, {
    method: "POST",
    headers: {
      "X-Api-Key": args.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: args.body.message,
      ...(args.body.repo ? { repo: args.body.repo } : {}),
      ...(args.body.repoToken ? { repoToken: args.body.repoToken } : {}),
      ...(args.body.dashboardUrl ? { dashboardUrl: args.body.dashboardUrl } : {}),
      ...(args.body.storeRepoUrl ? { storeRepoUrl: args.body.storeRepoUrl } : {}),
      ...(args.body.storeRef ? { storeRef: args.body.storeRef } : {}),
      ...(args.body.allowCrossRepo === true ? { allowCrossRepo: true } : {}),
    }),
  })

  if (!upstream.ok || !upstream.body) {
    args.res.writeHead(upstream.status, { "Content-Type": "application/json" })
    args.res.end(JSON.stringify({ error: "upstream error", status: upstream.status }))
    return
  }

  // Pass-through SSE.
  args.res.writeHead(200, {
    "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })
  const reader = upstream.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      args.res.write(Buffer.from(value))
    }
  } finally {
    args.res.end()
  }
}

interface ProxyStreamToBrainServeArgs {
  req: IncomingMessage
  res: ServerResponse
  brainServeUrl: string
  apiKey: string
  chatId: string
  since: number
  doFetch: typeof fetch
}

async function proxyStreamToBrainServe(args: ProxyStreamToBrainServeArgs): Promise<void> {
  const url = `${args.brainServeUrl.replace(/\/$/, "")}/chats/${encodeURIComponent(args.chatId)}/stream?since=${args.since}`
  const upstream = await args.doFetch(url, {
    method: "GET",
    headers: { "X-Api-Key": args.apiKey },
  })

  if (!upstream.ok || !upstream.body) {
    args.res.writeHead(upstream.status, { "Content-Type": "application/json" })
    args.res.end(JSON.stringify({ error: "upstream error", status: upstream.status }))
    return
  }

  args.res.writeHead(200, {
    "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })
  const reader = upstream.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      args.res.write(Buffer.from(value))
    }
  } finally {
    args.res.end()
  }
}

interface ProxyToHermesArgs {
  res: ServerResponse
  hermesUrl: string
  apiKey: string
  chatId: string
  message: string
  model: string
  doFetch: typeof fetch
}

async function proxyToHermes(args: ProxyToHermesArgs): Promise<void> {
  const openAIBody = brainToOpenAIRequest({ chatId: args.chatId, message: args.message, model: args.model })
  const url = `${args.hermesUrl.replace(/\/$/, "")}/v1/chat/completions`

  const upstream = await args.doFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
      // Use the dashboard's chatId as Hermes's session id so consecutive
      // messages in the same chat share Hermes's session state (memory,
      // tools, conversation history). Without this header Hermes would
      // treat each request as a new session and the chat would lose
      // context after the first turn.
      "X-Hermes-Session-Id": args.chatId,
    },
    body: JSON.stringify(openAIBody),
  })

  if (!upstream.ok || !upstream.body) {
    let detail = ""
    try {
      detail = await upstream.text()
    } catch {
      // ignore
    }
    args.res.writeHead(upstream.status, { "Content-Type": "application/json" })
    args.res.end(JSON.stringify({ error: "hermes upstream error", status: upstream.status, detail }))
    return
  }

  // Translate OpenAI SSE → Brain SSE.
  setSseHeaders(args.res)

  // Initial handshake (unsequenced per Brain protocol).
  const handshake: BrainEvent = { type: "chat", chatId: args.chatId }
  writeSseLine(args.res, `data: ${JSON.stringify(handshake)}\n\n`)

  const translator = translateOpenAISseToBrain({
    chatId: args.chatId,
    write: (line) => writeSseLine(args.res, line),
  })

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      translator.feed(decoder.decode(value, { stream: true }))
    }
    translator.feed(decoder.decode())
    translator.end()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[brain-proxy] hermes stream error: ${msg}\n`)
    const errorEv: BrainEvent = { type: "error", error: msg, chatId: args.chatId }
    writeSseLine(args.res, `data: ${JSON.stringify(errorEv)}\n\n`)
    // Also emit `done` so strict Brain SSE consumers (which wait for `done`
    // to terminate the turn) never hang waiting for a terminator that
    // never comes when the upstream dies mid-stream. The dashboard treats
    // the preceding `error` event as the actual failure signal; `done`
    // here just unblocks the consumer's state machine.
    const doneEv: BrainEvent = { type: "done", chatId: args.chatId }
    writeSseLine(args.res, `data: ${JSON.stringify(doneEv)}\n\n`)
  } finally {
    args.res.end()
  }
}

/**
 * Start the brain proxy on the given port (0 = random). Returns the proxy
 * plus its URL.
 */
export async function startBrainProxy(opts: BrainProxyOptions & { port?: number; host?: string }): Promise<BrainProxy> {
  const { httpServer, handler } = buildBrainProxy(opts)
  const port = opts.port ?? 0
  const host = opts.host ?? "127.0.0.1"
  await new Promise<void>((resolve) => httpServer.listen(port, host, () => resolve()))
  const addr = httpServer.address() as AddressInfo
  return {
    httpServer,
    port: addr.port,
    url: `http://${host}:${addr.port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
      }),
    handler,
  }
}
