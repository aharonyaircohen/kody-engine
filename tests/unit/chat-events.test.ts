import { afterEach, describe, expect, it, vi } from "vitest"
import type { ChatEvent } from "../../src/chat/events.js"
import { HttpSink, makeRunId, TeeSink } from "../../src/chat/events.js"

const EV: ChatEvent = {
  event: "chat.message",
  payload: { sessionId: "s1", role: "assistant", content: "hi" },
  runId: "chat-s1-msg",
  emittedAt: "2025-01-01T00:00:00.000Z",
}

describe("chat/events", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("HttpSink POSTs to /api/kody/events/ingest with sessionId + Bearer token", async () => {
    const fetchMock: typeof fetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const warn = vi.fn()

    const sink = new HttpSink("https://dash.example?token=tk", "s1", undefined, fetchMock, { warn })
    await sink.emit(EV)

    const mock = fetchMock as unknown as ReturnType<typeof vi.fn>
    expect(mock).toHaveBeenCalledTimes(1)
    const call = mock.mock.calls[0]
    expect(call).toBeDefined()
    const url = String(call![0])
    const init = call![1] as RequestInit
    expect(url).toBe("https://dash.example/api/kody/events/ingest?sessionId=s1&token=tk")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tk")
    expect(JSON.parse(String(init.body))).toEqual(EV)
    expect(warn).not.toHaveBeenCalled()
  })

  it("HttpSink throws at construction when token is missing", () => {
    expect(() => new HttpSink("https://dash.example", "s1")).toThrow(/session token/)
  })

  it("HttpSink accepts an explicit token override", async () => {
    const fetchMock: typeof fetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const sink = new HttpSink("https://dash.example", "s1", "explicit-tk", fetchMock, { warn: () => {} })
    await sink.emit(EV)
    const mock = fetchMock as unknown as ReturnType<typeof vi.fn>
    const call = mock.mock.calls[0]!
    expect(String(call[0])).toContain("token=explicit-tk")
  })

  it("HttpSink swallows non-2xx without throwing", async () => {
    const fetchMock: typeof fetch = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
    const warn = vi.fn()
    const sink = new HttpSink("https://dash.example?token=x", "s1", undefined, fetchMock, { warn })
    await expect(sink.emit(EV)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it("HttpSink swallows network errors without throwing", async () => {
    const fetchMock: typeof fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const warn = vi.fn()
    const sink = new HttpSink("https://dash.example?token=x", "s1", undefined, fetchMock, { warn })
    await expect(sink.emit(EV)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it("TeeSink emits to every child sink concurrently", async () => {
    const a: ChatEvent[] = []
    const b: ChatEvent[] = []
    const tee = new TeeSink([
      { emit: async (e: ChatEvent) => { a.push(e) } },
      { emit: async (e: ChatEvent) => { b.push(e) } },
    ])
    await tee.emit(EV)
    expect(a).toEqual([EV])
    expect(b).toEqual([EV])
  })

  it("makeRunId is deterministic", () => {
    expect(makeRunId("s1", "done")).toBe("chat-s1-done")
  })
})
