/**
 * Brain-serve HTTP server tests.
 *
 * Exercises the Brain SSE protocol surface end-to-end against the real
 * Node http.Server — no upstream LiteLLM, no real agent. `runChatTurn` is
 * stubbed via the buildServer seam so we can drive deterministic event
 * streams through the sink and assert the translated SSE output.
 */

import * as fs from "node:fs"
import type { AddressInfo } from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatEvent } from "../../src/chat/events.js"
import type { ChatTurnOptions, ChatTurnResult } from "../../src/chat/loop.js"
import type { ChatTurn } from "../../src/chat/session.js"
import type { SessionStore, SessionStoreOptions } from "../../src/chat/session-store.js"
import {
  authOk,
  type BrainEvent,
  BrainSseSink,
  BrokerSink,
  type BuildServerOptions,
  buildServer,
  ensureRepoCwd,
  hasStateBackendConfig,
  hydrateBrainDefinitions,
} from "../../src/servers/brain-serve.js"

const MODEL = { provider: "anthropic" as const, model: "claude-haiku-4-5-20251001" }
const KEY = "test-key-do-not-leak"

describe("repo-scoped definition hydration", () => {
  it("hydrates definitions inside the request repository workspace", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-brain-definitions-"))
    const listDefinitions = vi.fn().mockResolvedValue([])

    try {
      await hydrateBrainDefinitions({
        cwd,
        repo: "acme/widgets",
        env: {
          CONVEX_URL: "https://example.convex.cloud",
          KODY_SERVICE_KEY: "service-key",
        },
        backend: { listDefinitions },
      })

      expect(listDefinitions).toHaveBeenCalledTimes(5)
      expect(
        JSON.parse(fs.readFileSync(path.join(cwd, ".kody-engine/definitions/manifest.json"), "utf8")),
      ).toMatchObject({ tenantId: "acme/widgets" })
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

function memoryStoreFactory(): (opts: SessionStoreOptions) => SessionStore {
  const sessions = new Map<string, ChatTurn[]>()
  return (opts) => {
    const turns = sessions.get(opts.sessionId) ?? []
    sessions.set(opts.sessionId, turns)
    return {
      backend: "convex",
      readMode: async () => "interactive",
      readActiveAgent: async () => ({ slug: "kody", title: "Kody" }),
      readTurns: async () => [...turns],
      appendTurn: async (turn) => {
        turns.push(turn)
      },
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// authOk
// ────────────────────────────────────────────────────────────────────────────

describe("authOk", () => {
  const make = (headers: Record<string, string>) => ({ headers }) as unknown as import("node:http").IncomingMessage

  it("accepts a correct X-Api-Key header", () => {
    expect(authOk(make({ "x-api-key": KEY }), KEY)).toBe(true)
  })

  it("accepts a correct Bearer token", () => {
    expect(authOk(make({ authorization: `Bearer ${KEY}` }), KEY)).toBe(true)
  })

  it("accepts a Bearer token with mixed-case scheme", () => {
    expect(authOk(make({ authorization: `bearer ${KEY}` }), KEY)).toBe(true)
  })

  it("rejects when no auth header is present", () => {
    expect(authOk(make({}), KEY)).toBe(false)
  })

  it("rejects when the X-Api-Key value is wrong", () => {
    expect(authOk(make({ "x-api-key": "nope" }), KEY)).toBe(false)
  })

  it("rejects when the Bearer token is wrong", () => {
    expect(authOk(make({ authorization: "Bearer nope" }), KEY)).toBe(false)
  })

  it("rejects Basic auth even when the value matches", () => {
    expect(authOk(make({ authorization: `Basic ${KEY}` }), KEY)).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// BrainSseSink — translation table
// ────────────────────────────────────────────────────────────────────────────

class CaptureRes {
  chunks: string[] = []
  ended = false
  write(s: string) {
    this.chunks.push(s)
    return true
  }
  end() {
    this.ended = true
  }
}

function makeEvent(event: ChatEvent["event"], payload: Record<string, unknown>): ChatEvent {
  return {
    event,
    payload,
    runId: "test-run",
    emittedAt: new Date().toISOString(),
  }
}

function parseSse(chunks: string[]): BrainEvent[] {
  const events: BrainEvent[] = []
  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      if (line.startsWith("data: ")) {
        events.push(JSON.parse(line.slice(6)) as BrainEvent)
      }
    }
  }
  return events
}

describe("BrainSseSink", () => {
  it("translates chat.message into a text event with the assistant content", async () => {
    const res = new CaptureRes()
    const sink = new BrainSseSink(res as unknown as import("node:http").ServerResponse, "c1")
    await sink.emit(makeEvent("chat.message", { content: "hello world" }))
    const out = parseSse(res.chunks)
    expect(out).toEqual([{ type: "text", text: "hello world", chatId: "c1" }])
  })

  it("drops chat.message when content is empty", async () => {
    const res = new CaptureRes()
    const sink = new BrainSseSink(res as unknown as import("node:http").ServerResponse, "c1")
    await sink.emit(makeEvent("chat.message", { content: "" }))
    expect(res.chunks).toEqual([])
  })

  it("translates chat.tool (phase=use) into tool_use; ignores phase=result", async () => {
    const res = new CaptureRes()
    const sink = new BrainSseSink(res as unknown as import("node:http").ServerResponse, "c1")
    await sink.emit(makeEvent("chat.tool", { phase: "use", name: "Read", input: { p: "x.ts" } }))
    await sink.emit(makeEvent("chat.tool", { phase: "result", content: "ok" }))
    const out = parseSse(res.chunks)
    expect(out).toEqual([{ type: "tool_use", name: "Read", input: { p: "x.ts" }, chatId: "c1" }])
  })

  it("falls back to name='tool' when chat.tool has no name", async () => {
    const res = new CaptureRes()
    const sink = new BrainSseSink(res as unknown as import("node:http").ServerResponse, "c1")
    await sink.emit(makeEvent("chat.tool", { phase: "use", input: { x: 1 } }))
    const out = parseSse(res.chunks)
    expect(out[0]).toMatchObject({ type: "tool_use", name: "tool" })
  })

  it("translates chat.done into done", async () => {
    const res = new CaptureRes()
    const sink = new BrainSseSink(res as unknown as import("node:http").ServerResponse, "c1")
    await sink.emit(makeEvent("chat.done", {}))
    expect(parseSse(res.chunks)).toEqual([{ type: "done", chatId: "c1" }])
  })

  it("translates chat.error into error and forwards the message", async () => {
    const res = new CaptureRes()
    const sink = new BrainSseSink(res as unknown as import("node:http").ServerResponse, "c1")
    await sink.emit(makeEvent("chat.error", { error: "boom" }))
    expect(parseSse(res.chunks)).toEqual([{ type: "error", error: "boom", chatId: "c1" }])
  })

  it("drops chat.thinking entirely (not part of Brain protocol)", async () => {
    const res = new CaptureRes()
    const sink = new BrainSseSink(res as unknown as import("node:http").ServerResponse, "c1")
    await sink.emit(makeEvent("chat.thinking", { text: "hmm" }))
    expect(res.chunks).toEqual([])
  })
})

describe("BrokerSink", () => {
  it("keeps local Brain turns local when Convex is not configured", async () => {
    const events: BrainEvent[] = []
    const sink = new BrokerSink((event) => events.push(event), "c1", "owner/repo")

    await expect(sink.emit(makeEvent("chat.tool", { phase: "use", name: "Read", input: {} }))).resolves.toBeUndefined()
    expect(events).toEqual([{ type: "tool_use", name: "Read", input: {}, chatId: "c1" }])
  })
})

describe("hasStateBackendConfig", () => {
  it("requires both Convex settings", () => {
    expect(hasStateBackendConfig({})).toBe(false)
    expect(hasStateBackendConfig({ CONVEX_URL: "https://example.convex.cloud" })).toBe(false)
    expect(hasStateBackendConfig({ KODY_SERVICE_KEY: "service-key" })).toBe(false)
    expect(hasStateBackendConfig({ CONVEX_URL: "https://example.convex.cloud", KODY_SERVICE_KEY: "service-key" })).toBe(
      true,
    )
  })
})

// ────────────────────────────────────────────────────────────────────────────
// buildServer — full HTTP integration against a real socket
// ────────────────────────────────────────────────────────────────────────────

interface BootedServer {
  url: string
  close: () => Promise<void>
}

async function boot(
  runTurn: (opts: ChatTurnOptions) => Promise<ChatTurnResult>,
  cwd: string,
  extra: Partial<BuildServerOptions> = {},
): Promise<BootedServer> {
  const server = buildServer({
    apiKey: KEY,
    cwd,
    model: MODEL,
    litellmUrl: null,
    runTurn,
    createStore: memoryStoreFactory(),
    ...extra,
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const addr = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

type WireEvent = BrainEvent & { seq?: number }

async function readSseBody(res: Response): Promise<WireEvent[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const events: WireEvent[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
  }
  for (const line of buf.split("\n")) {
    if (line.startsWith("data: ")) {
      events.push(JSON.parse(line.slice(6)) as WireEvent)
    }
  }
  return events
}

async function readNextSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: { buf: string },
): Promise<WireEvent> {
  while (true) {
    const boundary = state.buf.indexOf("\n\n")
    if (boundary >= 0) {
      const chunk = state.buf.slice(0, boundary)
      state.buf = state.buf.slice(boundary + 2)
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          return JSON.parse(line.slice(6)) as WireEvent
        }
      }
    }
    const { done, value } = await reader.read()
    if (done) throw new Error("SSE stream ended before next event")
    state.buf += decoder.decode(value, { stream: true })
  }
}

describe("buildServer routes", () => {
  let tmp: string
  let booted: BootedServer | null = null

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-brain-serve-"))
  })
  afterEach(async () => {
    if (booted) {
      await booted.close()
      booted = null
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("GET /healthz returns 200 ok without auth", async () => {
    booted = await boot(async () => ({ exitCode: 0 }), tmp)
    const res = await fetch(`${booted.url}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("rejects unauthenticated POST /chats/:id/messages with 401", async () => {
    booted = await boot(async () => ({ exitCode: 0 }), tmp)
    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    })
    expect(res.status).toBe(401)
  })

  it("returns 404 for unknown routes", async () => {
    booted = await boot(async () => ({ exitCode: 0 }), tmp)
    const res = await fetch(`${booted.url}/nope`, {
      headers: { "x-api-key": KEY },
    })
    expect(res.status).toBe(404)
  })

  it("rejects POST without a message body with 400", async () => {
    booted = await boot(async () => {
      throw new Error("should not run turn")
    }, tmp)
    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it("rejects POST with invalid JSON with 400", async () => {
    booted = await boot(async () => {
      throw new Error("should not run turn")
    }, tmp)
    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: "{not json",
    })
    expect(res.status).toBe(400)
  })

  it("streams handshake → text → done for a successful chat turn", async () => {
    booted = await boot(async (opts) => {
      await opts.sink.emit(makeEvent("chat.message", { content: "hi back" }))
      await opts.sink.emit(makeEvent("chat.done", { sessionId: opts.sessionId }))
      return { exitCode: 0, reply: "hi back" }
    }, tmp)
    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "hi" }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const events = await readSseBody(res)
    // Turn now flows through the broker: handshake is unsequenced, every
    // subsequent event carries a per-chat monotonic seq.
    expect(events[0]).toEqual({ type: "chat", chatId: "c1" })
    expect(events[1]).toMatchObject({ type: "text", text: "hi back", chatId: "c1" })
    expect(events[2]).toMatchObject({ type: "done", chatId: "c1" })
    expect(events[1]!.seq).toBe(1)
    expect(events[2]!.seq).toBe(2)
  })

  it("selects the runtime adapter from the request", async () => {
    let observedDriver: ChatTurnOptions["driver"]
    booted = await boot(async (opts) => {
      observedDriver = opts.driver
      await opts.sink.emit(makeEvent("chat.done", { sessionId: opts.sessionId }))
      return { exitCode: 0 }
    }, tmp)
    const res = await fetch(`${booted.url}/chats/codex/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "hi", runtime: "codex app-server" }),
    })
    expect(res.status).toBe(200)
    await readSseBody(res)
    expect(observedDriver).toBe("codex-app-server")
  })

  it("rejects an unsupported runtime before starting a turn", async () => {
    booted = await boot(async () => {
      throw new Error("should not run turn")
    }, tmp)
    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "hi", runtime: "unknown" }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Unsupported Brain runtime")
  })

  it("opens the stream before repo clone finishes", async () => {
    let releaseClone!: () => void
    const cloneGate = new Promise<void>((resolve) => {
      releaseClone = resolve
    })
    let cloneStarted = false

    booted = await boot(
      async (opts) => {
        await opts.sink.emit(makeEvent("chat.done", { sessionId: opts.sessionId }))
        return { exitCode: 0 }
      },
      tmp,
      {
        reposRoot: path.join(tmp, "repos"),
        cloneRepo: async (_repo, _token, dir) => {
          cloneStarted = true
          await cloneGate
          fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
        },
      },
    )

    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({
        message: "hi",
        repo: "acme/widgets",
        firstTurn: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(cloneStarted).toBe(true)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const state = { buf: "" }
    expect(await readNextSseEvent(reader, decoder, state)).toEqual({
      type: "chat",
      chatId: "c1",
    })
    expect(await readNextSseEvent(reader, decoder, state)).toMatchObject({
      type: "tool_use",
      name: "prepare_repo",
      input: { repo: "acme/widgets" },
    })

    releaseClone()
    const events: WireEvent[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      state.buf += decoder.decode(value, { stream: true })
    }
    for (const line of state.buf.split("\n")) {
      if (line.startsWith("data: ")) {
        events.push(JSON.parse(line.slice(6)) as WireEvent)
      }
    }
    expect(events[events.length - 1]).toMatchObject({ type: "done" })
  })

  it("appends the user message to the canonical store before invoking the turn", async () => {
    let observedSessionFile = ""
    let observedTurns: ChatTurn[] = []
    booted = await boot(async (opts) => {
      observedSessionFile = opts.sessionFile
      observedTurns = await opts.store!.readTurns()
      const last = observedTurns.at(-1)!
      expect(last.role).toBe("user")
      expect(last.content).toBe("from the user")
      await opts.sink.emit(makeEvent("chat.done", {}))
      return { exitCode: 0 }
    }, tmp)
    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "from the user" }),
    })
    expect(res.status).toBe(200)
    await readSseBody(res)
    expect(observedSessionFile).toContain(".kody-engine/runtime/sessions/c1.jsonl")
    expect(observedTurns).toHaveLength(1)
    expect(fs.existsSync(observedSessionFile)).toBe(false)
  })

  it("emits an error SSE event when the turn throws", async () => {
    booted = await boot(async () => {
      throw new Error("agent kaboom")
    }, tmp)
    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "trigger error" }),
    })
    const events = await readSseBody(res)
    expect(events[0]).toEqual({ type: "chat", chatId: "c1" })
    expect(events[events.length - 1]).toMatchObject({
      type: "error",
      error: "agent kaboom",
      chatId: "c1",
    })
  })

  it("URL-decodes the chatId from the path", async () => {
    let observed = ""
    booted = await boot(async (opts) => {
      observed = opts.sessionId
      await opts.sink.emit(makeEvent("chat.done", {}))
      return { exitCode: 0 }
    }, tmp)
    const res = await fetch(`${booted.url}/chats/user%2Falice%2Fchat-1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "x" }),
    })
    expect(res.status).toBe(200)
    await readSseBody(res)
    expect(observed).toBe("user/alice/chat-1")
  })

  it("uses the visible conversation id for persistence without changing the runtime chat id", async () => {
    let runtimeSessionId = ""
    let persistedSessionId = ""
    booted = await boot(
      async (opts) => {
        runtimeSessionId = opts.sessionId
        await opts.sink.emit(makeEvent("chat.done", {}))
        return { exitCode: 0 }
      },
      tmp,
      {
        createStore: (opts) => {
          persistedSessionId = opts.sessionId
          return memoryStoreFactory()(opts)
        },
      },
    )
    const res = await fetch(`${booted.url}/chats/runtime%2Fepoch-2/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({
        message: "x",
        conversationId: "visible-conversation",
      }),
    })
    expect(res.status).toBe(200)
    await readSseBody(res)
    expect(runtimeSessionId).toBe("runtime/epoch-2")
    expect(persistedSessionId).toBe("visible-conversation")
  })

  it("rejects a path-traversal chatId with 400 and never invokes the turn", async () => {
    let invoked = false
    booted = await boot(async (opts) => {
      invoked = true
      await opts.sink.emit(makeEvent("chat.done", {}))
      return { exitCode: 0 }
    }, tmp)
    // `..%2F..%2F..%2Ftmp%2Fevil` decodes to `../../../tmp/evil` — would escape
    // the sessions root into an arbitrary write/read if not validated.
    const res = await fetch(`${booted.url}/chats/..%2F..%2F..%2Ftmp%2Fevil/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "x" }),
    })
    expect(res.status).toBe(400)
    expect(invoked).toBe(false)
  })

  it("preserves canonical multi-turn history across two requests", async () => {
    let firstSessionFile = ""
    let secondSessionFile = ""
    const observedHistories: ChatTurn[][] = []
    booted = await boot(async (opts) => {
      if (!firstSessionFile) firstSessionFile = opts.sessionFile
      else secondSessionFile = opts.sessionFile
      observedHistories.push(await opts.store!.readTurns())
      await opts.sink.emit(makeEvent("chat.message", { content: `ack ${opts.sessionId}` }))
      await opts.sink.emit(makeEvent("chat.done", {}))
      return { exitCode: 0 }
    }, tmp)

    await readSseBody(
      await fetch(`${booted.url}/chats/c1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: JSON.stringify({ message: "first" }),
      }),
    )
    await readSseBody(
      await fetch(`${booted.url}/chats/c1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: JSON.stringify({ message: "second" }),
      }),
    )

    expect(firstSessionFile).toBe(secondSessionFile)
    expect(observedHistories.map((turns) => turns.map((turn) => turn.content))).toEqual([
      ["first"],
      ["first", "second"],
    ])
    expect(fs.existsSync(firstSessionFile)).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Resume / reconnect — the 300s-ceiling fix
// ────────────────────────────────────────────────────────────────────────────

describe("buildServer resume (/chats/:id/stream)", () => {
  let tmp: string
  let booted: BootedServer | null = null

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-brain-resume-"))
  })
  afterEach(async () => {
    if (booted) {
      await booted.close()
      booted = null
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("replays a finished turn from cursor 0 then closes (no hang)", async () => {
    const cid = `c-replay-${Date.now()}`
    booted = await boot(async (opts) => {
      await opts.sink.emit(makeEvent("chat.message", { content: "full reply" }))
      await opts.sink.emit(makeEvent("chat.done", {}))
      return { exitCode: 0 }
    }, tmp)

    await readSseBody(
      await fetch(`${booted.url}/chats/${cid}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: JSON.stringify({ message: "hi" }),
      }),
    )

    const res = await fetch(`${booted.url}/chats/${cid}/stream?since=0`, {
      headers: { "x-api-key": KEY },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const ev = await readSseBody(res)
    expect(ev[0]).toEqual({ type: "chat", chatId: cid })
    expect(ev.some((e) => e.type === "text" && e.text === "full reply")).toBe(true)
    expect(ev[ev.length - 1]).toMatchObject({ type: "done" })
  })

  it("replays only events after the cursor", async () => {
    const cid = `c-cursor-${Date.now()}`
    booted = await boot(async (opts) => {
      await opts.sink.emit(makeEvent("chat.message", { content: "part one" }))
      await opts.sink.emit(makeEvent("chat.done", {}))
      return { exitCode: 0 }
    }, tmp)
    await readSseBody(
      await fetch(`${booted.url}/chats/${cid}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: JSON.stringify({ message: "hi" }),
      }),
    )
    // seq 1 = text, seq 2 = done. Resume from 1 → only the done remains.
    const ev = await readSseBody(
      await fetch(`${booted.url}/chats/${cid}/stream?since=1`, {
        headers: { "x-api-key": KEY },
      }),
    )
    const seqd = ev.filter((e) => typeof e.seq === "number")
    expect(seqd.every((e) => (e.seq ?? 0) > 1)).toBe(true)
    expect(ev[ev.length - 1]).toMatchObject({ type: "done" })
  })

  it("reconnect mid-turn: replays the gap then live-tails to the terminal event", async () => {
    const cid = `c-live-${Date.now()}`
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    booted = await boot(async (opts) => {
      await opts.sink.emit(makeEvent("chat.message", { content: "before cut" }))
      await gate // turn is "still running" while the client is disconnected
      await opts.sink.emit(makeEvent("chat.message", { content: "after cut" }))
      await opts.sink.emit(makeEvent("chat.done", {}))
      return { exitCode: 0 }
    }, tmp)

    // Start the turn but abort the connection almost immediately (simulated
    // Vercel kill) — the turn keeps running server-side.
    const ac = new AbortController()
    const startP = fetch(`${booted.url}/chats/${cid}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "go" }),
      signal: ac.signal,
    }).catch(() => null)
    await new Promise((r) => setTimeout(r, 150))
    ac.abort()
    await startP

    // Reconnect from cursor 0; release the turn so it finishes while attached.
    const resP = fetch(`${booted.url}/chats/${cid}/stream?since=0`, {
      headers: { "x-api-key": KEY },
    })
    await new Promise((r) => setTimeout(r, 100))
    release()
    const ev = await readSseBody(await resP)

    const texts = ev.filter((e) => e.type === "text").map((e) => e.text)
    expect(texts).toContain("before cut") // replayed gap
    expect(texts).toContain("after cut") // live-tailed
    expect(ev[ev.length - 1]).toMatchObject({ type: "done" })
  })

  it("seq stays monotonic across two turns of the same chat", async () => {
    const cid = `c-mono-${Date.now()}`
    booted = await boot(async (opts) => {
      await opts.sink.emit(makeEvent("chat.message", { content: "turn reply" }))
      await opts.sink.emit(makeEvent("chat.done", {}))
      return { exitCode: 0 }
    }, tmp)
    const url = `${booted.url}/chats/${cid}/messages`
    const send = async () =>
      readSseBody(
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": KEY },
          body: JSON.stringify({ message: "x" }),
        }),
      )
    await send()
    const ev2 = await send()
    const seqs = ev2.filter((e) => typeof e.seq === "number").map((e) => e.seq!)
    // Second turn's first seq continues past the first turn (which ended at 2).
    expect(Math.min(...seqs)).toBeGreaterThan(2)
  })

  it("unknown chat stream → handshake then close, never hangs", async () => {
    booted = await boot(async () => ({ exitCode: 0 }), tmp)
    const ev = await readSseBody(
      await fetch(`${booted.url}/chats/never-existed/stream?since=0`, {
        headers: { "x-api-key": KEY },
      }),
    )
    expect(ev).toEqual([{ type: "chat", chatId: "never-existed" }])
  })

  it("rejects unauthenticated stream with 401", async () => {
    booted = await boot(async () => ({ exitCode: 0 }), tmp)
    const res = await fetch(`${booted.url}/chats/c1/stream?since=0`)
    expect(res.status).toBe(401)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Multi-repo workspace — ensureRepoCwd (pure resolution + clone-on-first-use)
// ────────────────────────────────────────────────────────────────────────────

describe("ensureRepoCwd", () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-brain-repos-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const noClone = async () => {
    throw new Error("clone should not run")
  }

  it("returns baseCwd when no repo is supplied", async () => {
    const base = path.join(tmp, "boot")
    const dir = await ensureRepoCwd({
      baseCwd: base,
      reposRoot: path.join(tmp, "repos"),
      cloneRepo: noClone,
    })
    expect(dir).toBe(base)
  })

  it("falls back to baseCwd for a malformed / traversing repo", async () => {
    const base = path.join(tmp, "boot")
    const reposRoot = path.join(tmp, "repos")
    for (const bad of ["noslash", "../escape", "a/../../etc", "/abs/path", "a/b/c"]) {
      const dir = await ensureRepoCwd({
        baseCwd: base,
        reposRoot,
        repo: bad,
        cloneRepo: noClone,
      })
      expect(dir).toBe(base)
    }
  })

  it("clones into reposRoot/<owner>/<name> on first use", async () => {
    const reposRoot = path.join(tmp, "repos")
    const calls: Array<{ repo: string; token?: string; dir: string }> = []
    const cloneRepo = async (repo: string, token: string | undefined, dir: string) => {
      calls.push({ repo, token, dir })
      fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
    }
    const dir = await ensureRepoCwd({
      baseCwd: path.join(tmp, "boot"),
      reposRoot,
      repo: "acme/widgets",
      repoToken: "tok",
      cloneRepo,
    })
    expect(dir).toBe(path.join(reposRoot, "acme/widgets"))
    expect(calls).toEqual([{ repo: "acme/widgets", token: "tok", dir: path.join(reposRoot, "acme/widgets") }])
  })

  it("skips cloning when the repo is already present", async () => {
    const reposRoot = path.join(tmp, "repos")
    const dir = path.join(reposRoot, "acme/widgets")
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
    const out = await ensureRepoCwd({
      baseCwd: path.join(tmp, "boot"),
      reposRoot,
      repo: "acme/widgets",
      cloneRepo: noClone,
    })
    expect(out).toBe(dir)
  })

  it("dedupes concurrent clones of the same repo (clones once)", async () => {
    const reposRoot = path.join(tmp, "repos")
    let calls = 0
    const cloneRepo = async (_repo: string, _token: string | undefined, dir: string) => {
      calls++
      await new Promise((r) => setTimeout(r, 20))
      fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
    }
    const [a, b] = await Promise.all([
      ensureRepoCwd({ baseCwd: tmp, reposRoot, repo: "acme/widgets", cloneRepo }),
      ensureRepoCwd({ baseCwd: tmp, reposRoot, repo: "acme/widgets", cloneRepo }),
    ])
    expect(a).toBe(b)
    expect(calls).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Multi-repo workspace — buildServer wiring (repo → agent cwd)
// ────────────────────────────────────────────────────────────────────────────

describe("buildServer multi-repo", () => {
  let tmp: string
  let booted: BootedServer | null = null

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-brain-multirepo-"))
  })
  afterEach(async () => {
    if (booted) {
      await booted.close()
      booted = null
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("runs the turn in the per-repo clone and stores the session cache under that clone", async () => {
    const reposRoot = path.join(tmp, "repos")
    const clones: string[] = []
    let observedCwd = ""
    let observedSessionFile = ""
    booted = await boot(
      async (opts) => {
        observedCwd = opts.cwd
        observedSessionFile = opts.sessionFile
        await opts.sink.emit(makeEvent("chat.done", {}))
        return { exitCode: 0 }
      },
      tmp,
      {
        reposRoot,
        cloneRepo: async (repo, _token, dir) => {
          clones.push(repo)
          fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
        },
      },
    )
    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "hi", repo: "acme/widgets", repoToken: "tok" }),
    })
    expect(res.status).toBe(200)
    await readSseBody(res)
    // Agent runs in the per-repo clone…
    expect(observedCwd).toBe(path.join(reposRoot, "acme/widgets"))
    expect(clones).toEqual(["acme/widgets"])
    // …and the session cache follows that repo; the backend is the durable cross-machine source.
    expect(observedSessionFile).toBe(
      path.join(reposRoot, "acme/widgets", ".kody-engine", "runtime", "sessions", "c1.jsonl"),
    )
  })

  it("passes Dashboard CMS settings from the request into the chat turn", async () => {
    let observed: ChatTurnOptions | null = null
    booted = await boot(
      async (opts) => {
        observed = opts
        await opts.sink.emit(makeEvent("chat.done", {}))
        return { exitCode: 0 }
      },
      tmp,
      {
        reposRoot: path.join(tmp, "repos"),
        cloneRepo: async (_repo, _token, dir) => {
          fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
        },
      },
    )

    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({
        message: "show course",
        repo: "acme/widgets",
        repoToken: "repo-token",
        dashboardUrl: "https://dashboard.example.test",
        storeRepoUrl: "https://github.com/acme/kody-store",
        storeRef: "stable",
      }),
    })

    expect(res.status).toBe(200)
    await readSseBody(res)
    const cms = observed as
      | (ChatTurnOptions & {
          cmsDashboardUrl?: string
          cmsRepoSlug?: string
          cmsToken?: string
          cmsStoreRepoUrl?: string
          cmsStoreRef?: string
        })
      | null
    expect(cms?.cmsDashboardUrl).toBe("https://dashboard.example.test")
    expect(cms?.cmsRepoSlug).toBe("acme/widgets")
    expect(cms?.cmsToken).toBe("repo-token")
    expect(cms?.cmsStoreRepoUrl).toBe("https://github.com/acme/kody-store")
    expect(cms?.cmsStoreRef).toBe("stable")
  })

  it("passes a selected agent identity into the chat turn", async () => {
    const observed: ChatTurnOptions[] = []
    booted = await boot(
      async (opts) => {
        observed.push(opts)
        await opts.sink.emit(makeEvent("chat.done", {}))
        return { exitCode: 0 }
      },
      tmp,
      {
        reposRoot: path.join(tmp, "repos"),
        cloneRepo: async (_repo, _token, dir) => {
          fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
        },
      },
    )

    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({
        message: "who are you?",
        repo: "acme/widgets",
        repoToken: "repo-token",
        agentIdentity: {
          slug: "repo-brain",
          body: "You are Repo Brain.",
        },
      }),
    })

    expect(res.status).toBe(200)
    await readSseBody(res)
    expect(observed[0]?.agentIdentity).toEqual({
      slug: "repo-brain",
      body: "You are Repo Brain.",
    })
  })

  it("does not expose fetch_repo to normal Repo Brain turns", async () => {
    const observed: ChatTurnOptions[] = []
    booted = await boot(
      async (opts) => {
        observed.push(opts)
        await opts.sink.emit(makeEvent("chat.done", {}))
        return { exitCode: 0 }
      },
      tmp,
      {
        reposRoot: path.join(tmp, "repos"),
        cloneRepo: async (_repo, _token, dir) => {
          fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
        },
      },
    )

    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({
        message: "which repos can you access?",
        repo: "acme/widgets",
        repoToken: "repo-token",
      }),
    })

    expect(res.status).toBe(200)
    await readSseBody(res)
    expect(observed[0]?.reposRoot).toBe(path.join(tmp, "repos"))
    expect(observed[0]?.enableFetchRepoTool).toBeUndefined()
  })

  it("can expose fetch_repo when an org-level caller opts in", async () => {
    const observed: ChatTurnOptions[] = []
    booted = await boot(
      async (opts) => {
        observed.push(opts)
        await opts.sink.emit(makeEvent("chat.done", {}))
        return { exitCode: 0 }
      },
      tmp,
      {
        reposRoot: path.join(tmp, "repos"),
        cloneRepo: async (_repo, _token, dir) => {
          fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
        },
      },
    )

    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({
        message: "compare repos",
        repo: "acme/widgets",
        repoToken: "repo-token",
        allowCrossRepo: true,
      }),
    })

    expect(res.status).toBe(200)
    await readSseBody(res)
    expect(observed[0]?.enableFetchRepoTool).toBe(true)
  })

  it("runs in the boot cwd when no repo is sent (single-repo behavior preserved)", async () => {
    let observedCwd = ""
    booted = await boot(
      async (opts) => {
        observedCwd = opts.cwd
        await opts.sink.emit(makeEvent("chat.done", {}))
        return { exitCode: 0 }
      },
      tmp,
      {
        cloneRepo: async () => {
          throw new Error("must not clone when no repo")
        },
      },
    )
    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "hi" }),
    })
    expect(res.status).toBe(200)
    await readSseBody(res)
    expect(observedCwd).toBe(tmp)
  })

  it("emits a chat.error when the clone fails (turn never runs)", async () => {
    booted = await boot(
      async () => {
        throw new Error("runTurn must not be reached")
      },
      tmp,
      {
        reposRoot: path.join(tmp, "repos"),
        cloneRepo: async () => {
          throw new Error("clone boom")
        },
      },
    )
    const res = await fetch(`${booted.url}/chats/c1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ message: "hi", repo: "acme/widgets" }),
    })
    const events = await readSseBody(res)
    expect(events[0]).toEqual({ type: "chat", chatId: "c1" })
    expect(events[events.length - 1]).toMatchObject({
      type: "error",
      error: "clone boom",
      chatId: "c1",
    })
  })
})
