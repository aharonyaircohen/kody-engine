import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatEvent } from "../../src/chat/events.js"
import { eventsFilePath, FileSink, HttpSink, makeRunId, TeeSink, withSessionParam } from "../../src/chat/events.js"

const EV: ChatEvent = {
  event: "chat.message",
  payload: { sessionId: "s1", role: "assistant", content: "hi" },
  runId: "chat-s1-msg",
  emittedAt: "2025-01-01T00:00:00.000Z",
}

describe("chat/events", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody2-chat-events-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("FileSink appends a JSON line", async () => {
    const file = path.join(tmp, "e.jsonl")
    const sink = new FileSink(file)
    await sink.emit(EV)
    await sink.emit({ ...EV, runId: "second" })
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).runId).toBe("chat-s1-msg")
    expect(JSON.parse(lines[1]!).runId).toBe("second")
  })

  it("HttpSink POSTs to dashboardUrl with sessionId appended", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)

    const sink = new HttpSink("https://dash/api/kody/events/ingest?token=tk", "s1")
    await sink.emit(EV)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    expect(call).toBeDefined()
    const [url, init] = call as [string, RequestInit]
    expect(String(url)).toBe("https://dash/api/kody/events/ingest?token=tk&sessionId=s1")
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual(EV)
  })

  it("HttpSink swallows non-2xx without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    )
    const warn = vi.fn()
    const sink = new HttpSink("https://dash/ingest?token=x", "s1", { warn })
    await expect(sink.emit(EV)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it("HttpSink swallows network errors without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED")
      }),
    )
    const warn = vi.fn()
    const sink = new HttpSink("https://dash/ingest?token=x", "s1", { warn })
    await expect(sink.emit(EV)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it("TeeSink emits to every child sink concurrently", async () => {
    const a: ChatEvent[] = []
    const b: ChatEvent[] = []
    const sinkA = {
      emit: async (e: ChatEvent) => {
        a.push(e)
      },
    }
    const sinkB = {
      emit: async (e: ChatEvent) => {
        b.push(e)
      },
    }
    const tee = new TeeSink([sinkA, sinkB])
    await tee.emit(EV)
    expect(a).toEqual([EV])
    expect(b).toEqual([EV])
  })

  it("withSessionParam picks the right joiner", () => {
    expect(withSessionParam("https://x/ingest", "s1")).toBe("https://x/ingest?sessionId=s1")
    expect(withSessionParam("https://x/ingest?token=tk", "s1")).toBe("https://x/ingest?token=tk&sessionId=s1")
  })

  it("makeRunId is deterministic", () => {
    expect(makeRunId("s1", "done")).toBe("chat-s1-done")
  })

  it("eventsFilePath lives under .kody/events", () => {
    expect(eventsFilePath("/repo", "abc")).toBe(path.join("/repo", ".kody", "events", "abc.jsonl"))
  })
})
