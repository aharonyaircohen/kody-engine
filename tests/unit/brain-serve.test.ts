/**
 * Brain-serve HTTP server tests.
 *
 * Exercises the Brain SSE protocol surface end-to-end against the real
 * Node http.Server — no upstream LiteLLM, no real agent. `runChatTurn` is
 * stubbed via the buildServer seam so we can drive deterministic event
 * streams through the sink and assert the translated SSE output.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { BrainSseSink, authOk, buildServer, type BrainEvent } from "../../src/scripts/brainServe.js"
import type { ChatEvent } from "../../src/chat/events.js"
import type { ChatTurnOptions, ChatTurnResult } from "../../src/chat/loop.js"

const MODEL = { provider: "anthropic" as const, model: "claude-haiku-4-5-20251001" }
const KEY = "test-key-do-not-leak"

// ────────────────────────────────────────────────────────────────────────────
// authOk
// ────────────────────────────────────────────────────────────────────────────

describe("authOk", () => {
  const make = (headers: Record<string, string>) =>
    ({ headers } as unknown as import("node:http").IncomingMessage)

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
): Promise<BootedServer> {
  const server = buildServer({
    apiKey: KEY,
    cwd,
    model: MODEL,
    litellmUrl: null,
    runTurn,
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

async function readSseBody(res: Response): Promise<BrainEvent[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const events: BrainEvent[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
  }
  for (const line of buf.split("\n")) {
    if (line.startsWith("data: ")) {
      events.push(JSON.parse(line.slice(6)) as BrainEvent)
    }
  }
  return events
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
    expect(events).toEqual([
      { type: "chat", chatId: "c1" },
      { type: "text", text: "hi back", chatId: "c1" },
      { type: "done", chatId: "c1" },
    ])
  })

  it("appends the user message to the session file before invoking the turn", async () => {
    let observedSessionFile = ""
    booted = await boot(async (opts) => {
      observedSessionFile = opts.sessionFile
      const raw = fs.readFileSync(opts.sessionFile, "utf-8").trim().split("\n")
      const last = JSON.parse(raw[raw.length - 1]!) as { role: string; content: string }
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
    expect(observedSessionFile).toContain(".kody/sessions/c1.jsonl")
    expect(fs.existsSync(observedSessionFile)).toBe(true)
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
    expect(events[events.length - 1]).toEqual({
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

  it("preserves multi-turn session history across two requests", async () => {
    let firstSessionFile = ""
    let secondSessionFile = ""
    booted = await boot(async (opts) => {
      if (!firstSessionFile) firstSessionFile = opts.sessionFile
      else secondSessionFile = opts.sessionFile
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
    const lines = fs.readFileSync(firstSessionFile, "utf-8").trim().split("\n")
    const userTurns = lines
      .map((l) => JSON.parse(l) as { role: string; content: string })
      .filter((t) => t.role === "user")
    expect(userTurns.map((t) => t.content)).toEqual(["first", "second"])
  })
})
