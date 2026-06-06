/**
 * Tests for the brain-proxy.
 *
 * The proxy is the dashboard-facing brain endpoint. It speaks Brain SSE to
 * clients and routes to brain-serve (passthrough) or Hermes (with translation).
 * Tests exercise both backends via a stub upstream fetch.
 */

import { afterEach, describe, expect, it } from "vitest"
import { startBrainProxy } from "../../src/servers/brain-proxy.js"

const KEY = "test-proxy-key-do-not-leak"

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface UpstreamResponse {
  ok: boolean
  status: number
  body?: string
  headers?: Record<string, string>
  sseChunks?: string[]
  /** If set, the stream errors with this message after `sseChunks` have been enqueued. */
  streamErrorAfterChunks?: string
}

function makeUpstream(responses: UpstreamResponse[]): {
  fetch: typeof fetch
  calls: { url: string; init?: RequestInit }[]
} {
  const calls: { url: string; init?: RequestInit }[] = []
  let idx = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString()
    calls.push({ url, ...(init ? { init } : {}) })
    const r = responses[idx++] ?? responses[responses.length - 1]!
    const chunks = r.sseChunks
    if (chunks && chunks.length > 0) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk))
          }
          if (r.streamErrorAfterChunks) {
            controller.error(new Error(r.streamErrorAfterChunks))
          } else {
            controller.close()
          }
        },
      })
      return new Response(stream, {
        status: r.status,
        headers: { "content-type": "text/event-stream", ...(r.headers ?? {}) },
      })
    }
    return new Response(r.body ?? "", { status: r.status, headers: r.headers ?? {} })
  }
  return { fetch: fetchImpl, calls }
}

async function readSseBody(res: Response): Promise<unknown[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const events: unknown[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
  }
  for (const line of buf.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        events.push(JSON.parse(line.slice(6)))
      } catch {
        // skip
      }
    }
  }
  return events
}

// ─── Health & auth ──────────────────────────────────────────────────────────

describe("brain-proxy: health & auth", () => {
  let proxy: Awaited<ReturnType<typeof startBrainProxy>> | null = null

  afterEach(async () => {
    if (proxy) {
      await proxy.stop()
      proxy = null
    }
  })

  it("responds to /healthz without auth", async () => {
    const { fetch: stubFetch } = makeUpstream([])
    proxy = await startBrainProxy({ apiKey: KEY, backend: "brain-serve", __fetch: stubFetch })
    const res = await fetch(`${proxy.url}/healthz`)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ ok: true, backend: "brain-serve" })
  })

  it("rejects POST /chats/:id/messages without auth", async () => {
    const { fetch: stubFetch } = makeUpstream([])
    proxy = await startBrainProxy({ apiKey: KEY, backend: "brain-serve", __fetch: stubFetch })
    const res = await fetch(`${proxy.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    })
    expect(res.status).toBe(401)
  })

  it("rejects unauthenticated /chats/:id/stream", async () => {
    const { fetch: stubFetch } = makeUpstream([])
    proxy = await startBrainProxy({ apiKey: KEY, backend: "brain-serve", __fetch: stubFetch })
    const res = await fetch(`${proxy.url}/chats/c1/stream?since=0`)
    expect(res.status).toBe(401)
  })
})

// ─── brain-serve backend (passthrough) ─────────────────────────────────────

describe("brain-proxy: brain-serve backend (passthrough)", () => {
  let proxy: Awaited<ReturnType<typeof startBrainProxy>> | null = null

  afterEach(async () => {
    if (proxy) {
      await proxy.stop()
      proxy = null
    }
  })

  it("forwards POST /chats/:id/messages to brain-serve with X-Api-Key", async () => {
    const upstream = makeUpstream([
      {
        ok: true,
        status: 200,
        sseChunks: [
          'data: {"type":"chat","chatId":"c1"}\n\n',
          'data: {"type":"text","text":"hello","chatId":"c1","seq":1}\n\n',
          'data: {"type":"done","chatId":"c1","seq":2}\n\n',
        ],
      },
    ])
    proxy = await startBrainProxy({ apiKey: KEY, backend: "brain-serve", __fetch: upstream.fetch })
    const res = await fetch(`${proxy.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "hi" }),
    })
    expect(res.status).toBe(200)
    const events = await readSseBody(res)
    expect(events).toHaveLength(3)
    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]!.url).toBe("http://localhost:8080/chats/c1/messages")
    const headers = upstream.calls[0]!.init?.headers as Record<string, string>
    expect(headers["X-Api-Key"]).toBe(KEY)
  })

  it("forwards GET /chats/:id/stream?since=N to brain-serve", async () => {
    const upstream = makeUpstream([{ ok: true, status: 200, sseChunks: ['data: {"type":"chat","chatId":"c1"}\n\n'] }])
    proxy = await startBrainProxy({ apiKey: KEY, backend: "brain-serve", __fetch: upstream.fetch })
    const res = await fetch(`${proxy.url}/chats/c1/stream?since=5`, {
      headers: { "x-api-key": KEY },
    })
    expect(res.status).toBe(200)
    expect(upstream.calls[0]!.url).toBe("http://localhost:8080/chats/c1/stream?since=5")
  })

  it("rejects an invalid chatId with 400", async () => {
    const upstream = makeUpstream([])
    proxy = await startBrainProxy({ apiKey: KEY, backend: "brain-serve", __fetch: upstream.fetch })
    const res = await fetch(`${proxy.url}/chats/..%2F..%2Fevil/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "x" }),
    })
    expect(res.status).toBe(400)
    expect(upstream.calls).toHaveLength(0)
  })

  it("routes to the configured brainServeUrl", async () => {
    const upstream = makeUpstream([
      {
        ok: true,
        status: 200,
        sseChunks: ['data: {"type":"chat","chatId":"c1"}\n\n', 'data: {"type":"done","chatId":"c1"}\n\n'],
      },
    ])
    proxy = await startBrainProxy({
      apiKey: KEY,
      backend: "brain-serve",
      brainServeUrl: "http://custom-brain:9000",
      __fetch: upstream.fetch,
    })
    await fetch(`${proxy.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "hi" }),
    })
    expect(upstream.calls[0]!.url).toBe("http://custom-brain:9000/chats/c1/messages")
  })
})

// ─── Hermes backend (translation) ───────────────────────────────────────────

describe("brain-proxy: Hermes backend (Brain↔OpenAI translation)", () => {
  let proxy: Awaited<ReturnType<typeof startBrainProxy>> | null = null

  afterEach(async () => {
    if (proxy) {
      await proxy.stop()
      proxy = null
    }
  })

  it("translates OpenAI SSE back to Brain SSE", async () => {
    const upstream = makeUpstream([
      {
        ok: true,
        status: 200,
        sseChunks: [
          'data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi "}}]}\n\n',
          'data: {"id":"x","choices":[{"index":0,"delta":{"content":"there"}}]}\n\n',
          'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        ],
      },
    ])
    proxy = await startBrainProxy({ apiKey: KEY, backend: "hermes", __fetch: upstream.fetch })
    const res = await fetch(`${proxy.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "hello" }),
    })
    expect(res.status).toBe(200)
    const events = (await readSseBody(res)) as Array<{ type: string; text?: string; chatId?: string; seq?: number }>
    // First event: chat handshake (unsequenced).
    expect(events[0]).toMatchObject({ type: "chat", chatId: "c1" })
    // Then text events with monotonic seq.
    const textEvents = events.filter((e) => e.type === "text")
    expect(textEvents).toHaveLength(2)
    expect(textEvents[0]).toMatchObject({ text: "hi ", seq: 1 })
    expect(textEvents[1]).toMatchObject({ text: "there", seq: 2 })
    // Then done.
    expect(events.at(-1)).toMatchObject({ type: "done", chatId: "c1" })
  })

  it("sends Bearer token to Hermes", async () => {
    const upstream = makeUpstream([
      { ok: true, status: 200, sseChunks: ['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', "data: [DONE]\n\n"] },
    ])
    proxy = await startBrainProxy({ apiKey: KEY, backend: "hermes", __fetch: upstream.fetch })
    await fetch(`${proxy.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "hi" }),
    })
    const headers = upstream.calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${KEY}`)
  })

  it("translates the Brain message body to an OpenAI messages array", async () => {
    const upstream = makeUpstream([
      { ok: true, status: 200, sseChunks: ['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', "data: [DONE]\n\n"] },
    ])
    proxy = await startBrainProxy({ apiKey: KEY, backend: "hermes", __fetch: upstream.fetch })
    await fetch(`${proxy.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "translate me" }),
    })
    const body = JSON.parse(upstream.calls[0]!.init?.body as string)
    expect(body).toMatchObject({
      messages: [{ role: "user", content: "translate me" }],
      stream: true,
    })
  })

  it("forwards X-Hermes-Session-Id = chatId so consecutive messages share a session (Gap 2)", async () => {
    const upstream = makeUpstream([
      { ok: true, status: 200, sseChunks: ['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', "data: [DONE]\n\n"] },
    ])
    proxy = await startBrainProxy({ apiKey: KEY, backend: "hermes", __fetch: upstream.fetch })
    await fetch(`${proxy.url}/chats/chat-42/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "first message of the chat" }),
    })
    const headers = upstream.calls[0]!.init?.headers as Record<string, string>
    // The chatId from the URL path becomes Hermes's session id. Without
    // this, every message would be a brand-new Hermes session and the
    // dashboard would lose context after the first turn.
    expect(headers["X-Hermes-Session-Id"]).toBe("chat-42")
  })

  it("rejects /chats/:id/stream on Hermes backend (no cursor replay support)", async () => {
    proxy = await startBrainProxy({ apiKey: KEY, backend: "hermes", __fetch: makeUpstream([]).fetch })
    const res = await fetch(`${proxy.url}/chats/c1/stream?since=0`, {
      headers: { "x-api-key": KEY },
    })
    expect(res.status).toBe(501)
  })

  it("emits a Brain error event when the Hermes upstream fails", async () => {
    const upstream = makeUpstream([{ ok: false, status: 502, body: "bad gateway" }])
    proxy = await startBrainProxy({ apiKey: KEY, backend: "hermes", __fetch: upstream.fetch })
    const res = await fetch(`${proxy.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "hi" }),
    })
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.error).toContain("hermes")
  })

  it("routes to the configured hermesUrl", async () => {
    const upstream = makeUpstream([
      { ok: true, status: 200, sseChunks: ['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', "data: [DONE]\n\n"] },
    ])
    proxy = await startBrainProxy({
      apiKey: KEY,
      backend: "hermes",
      hermesUrl: "http://custom-hermes:4000",
      __fetch: upstream.fetch,
    })
    await fetch(`${proxy.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "hi" }),
    })
    expect(upstream.calls[0]!.url).toBe("http://custom-hermes:4000/v1/chat/completions")
  })

  it("emits BOTH `error` and `done` when Hermes errors mid-stream (consumer must not hang)", async () => {
    // A Brain SSE consumer waits for `done` to terminate the turn. The proxy
    // previously emitted `error` and then closed the connection — leaving any
    // strict consumer waiting for a `done` that never arrived. Lock the
    // contract: every error path also emits `done` with the same chatId.
    const upstream = makeUpstream([
      {
        ok: true,
        status: 200,
        sseChunks: ['data: {"choices":[{"delta":{"content":"partial "}}]}\n\n'],
        streamErrorAfterChunks: "upstream crashed",
      },
    ])
    proxy = await startBrainProxy({ apiKey: KEY, backend: "hermes", __fetch: upstream.fetch })
    const res = await fetch(`${proxy.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "hi" }),
    })
    expect(res.status).toBe(200)
    const events = (await readSseBody(res)) as Array<{ type: string; chatId?: string; error?: string }>
    const errorEvent = events.find((e) => e.type === "error")
    const doneEvent = events.find((e) => e.type === "done")
    expect(errorEvent).toBeDefined()
    expect(errorEvent?.chatId).toBe("c1")
    expect(errorEvent?.error).toMatch(/upstream crashed/)
    // The critical invariant: a `done` is also emitted, so the dashboard
    // never hangs waiting for a turn terminator that the proxy never sent.
    expect(doneEvent).toBeDefined()
    expect(doneEvent?.chatId).toBe("c1")
  })
})

// ─── 404 ─────────────────────────────────────────────────────────────────────

describe("brain-proxy: 404", () => {
  let proxy: Awaited<ReturnType<typeof startBrainProxy>> | null = null

  afterEach(async () => {
    if (proxy) {
      await proxy.stop()
      proxy = null
    }
  })

  it("returns 404 for unknown routes", async () => {
    proxy = await startBrainProxy({ apiKey: KEY, backend: "brain-serve", __fetch: makeUpstream([]).fetch })
    const res = await fetch(`${proxy.url}/nope`, { headers: { "x-api-key": KEY } })
    expect(res.status).toBe(404)
  })
})
