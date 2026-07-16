import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ConvexHttpClient } from "convex/browser"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readSession } from "../../src/chat/session.js"
import { createSessionStore } from "../../src/chat/session-store.js"

const silentLogger = { info: () => {}, warn: () => {} }

interface MockCall {
  fn: unknown
  args: Record<string, unknown>
}

function makeMockClient(turnDocs: Array<{ seq: number; turn: unknown }>) {
  const mutations: MockCall[] = []
  const client = {
    query: vi.fn(async () => turnDocs),
    mutation: vi.fn(async (fn: unknown, args: Record<string, unknown>) => {
      mutations.push({ fn, args })
      return "id"
    }),
  } as unknown as ConvexHttpClient
  return { client, mutations }
}

describe("chat/session-store", () => {
  let tmp: string
  let file: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-session-store-"))
    file = path.join(tmp, "sessions", "s1.jsonl")
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("falls back to the JSONL store when no Convex client is available", async () => {
    const store = createSessionStore({
      sessionId: "s1",
      sessionFile: file,
      client: null,
      logger: silentLogger,
    })
    expect(store.backend).toBe("jsonl")
    expect(await store.readTurns()).toEqual([])
    await store.appendTurn({ role: "user", content: "hi", timestamp: "t1" })
    const turns = await store.readTurns()
    expect(turns).toHaveLength(1)
    expect(turns[0]?.content).toBe("hi")
  })

  it("falls back to JSONL when a client exists but no tenant is derivable", () => {
    const { client } = makeMockClient([])
    const store = createSessionStore({
      sessionId: "s1",
      sessionFile: file,
      client,
      tenantId: "",
      logger: silentLogger,
    })
    expect(store.backend).toBe("jsonl")
  })

  it("reads the transcript from Convex ordered by seq, skipping malformed turns", async () => {
    const { client } = makeMockClient([
      { seq: 1, turn: { role: "assistant", content: "hello", timestamp: "t2" } },
      { seq: 0, turn: { role: "user", content: "hi", timestamp: "t1" } },
      { seq: 2, turn: { role: "system", content: "nope" } },
      { seq: 3, turn: "garbage" },
    ])
    const store = createSessionStore({
      sessionId: "s1",
      sessionFile: file,
      client,
      tenantId: "owner/repo",
      logger: silentLogger,
    })
    expect(store.backend).toBe("convex")
    const turns = await store.readTurns()
    expect(turns.map((t) => t.content)).toEqual(["hi", "hello"])
    expect(client.query).toHaveBeenCalledWith(expect.anything(), {
      tenantId: "owner/repo",
      sessionId: "s1",
    })
  })

  it("backfills local JSONL turns into Convex when Convex is behind (workflow-seeded session)", async () => {
    // Simulate `kody chat --message` seeding the user turn into the local
    // JSONL only — Convex has no rows for this session yet.
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ role: "user", content: "Say hello and stop.", timestamp: "t1" })}\n`)
    const { client, mutations } = makeMockClient([])
    const store = createSessionStore({
      sessionId: "s1",
      sessionFile: file,
      client,
      tenantId: "owner/repo",
      logger: silentLogger,
    })
    const turns = await store.readTurns()
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ role: "user", content: "Say hello and stop.", toolCalls: [] })
    // Upsert + one append pushed the local turn up to Convex.
    expect(mutations).toHaveLength(2)
    expect(mutations[1]?.args).toMatchObject({
      tenantId: "owner/repo",
      sessionId: "s1",
      turn: { role: "user", content: "Say hello and stop." },
    })
  })

  it("backfills only the local tail beyond the Convex prefix", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ role: "user", content: "hi", timestamp: "t1" }),
        JSON.stringify({ role: "assistant", content: "hello", timestamp: "t2" }),
        JSON.stringify({ role: "user", content: "next question", timestamp: "t3" }),
      ].join("\n") + "\n",
    )
    const { client, mutations } = makeMockClient([
      { seq: 0, turn: { role: "user", content: "hi", timestamp: "t1" } },
      { seq: 1, turn: { role: "assistant", content: "hello", timestamp: "t2" } },
    ])
    const store = createSessionStore({
      sessionId: "s1",
      sessionFile: file,
      client,
      tenantId: "owner/repo",
      logger: silentLogger,
    })
    const turns = await store.readTurns()
    expect(turns.map((t) => t.content)).toEqual(["hi", "hello", "next question"])
    const appends = mutations.filter((m) => "turn" in m.args)
    expect(appends).toHaveLength(1)
    expect(appends[0]?.args.turn).toMatchObject({ content: "next question" })
  })

  it("does not backfill when Convex already has all local turns", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ role: "user", content: "hi", timestamp: "t1" })}\n`)
    const { client, mutations } = makeMockClient([
      { seq: 0, turn: { role: "user", content: "hi", timestamp: "t1" } },
      { seq: 1, turn: { role: "assistant", content: "hello", timestamp: "t2" } },
    ])
    const store = createSessionStore({
      sessionId: "s1",
      sessionFile: file,
      client,
      tenantId: "owner/repo",
      logger: silentLogger,
    })
    const turns = await store.readTurns()
    expect(turns).toHaveLength(2)
    expect(mutations).toHaveLength(0)
  })

  it("appends turns via chatSessions.upsert (once) + chatTurns.append and mirrors to JSONL", async () => {
    const { client, mutations } = makeMockClient([])
    const store = createSessionStore({
      sessionId: "s1",
      sessionFile: file,
      client,
      tenantId: "owner/repo",
      logger: silentLogger,
    })
    await store.appendTurn({ role: "assistant", content: "a1", timestamp: "t1" })
    await store.appendTurn({ role: "assistant", content: "a2", timestamp: "t2" })

    // 1 upsert (first append only) + 2 appends.
    expect(mutations).toHaveLength(3)
    expect(mutations[0]?.args).toMatchObject({
      tenantId: "owner/repo",
      sessionId: "s1",
      meta: { type: "meta", mode: "one-shot" },
    })
    expect(mutations[1]?.args).toMatchObject({
      tenantId: "owner/repo",
      sessionId: "s1",
      turn: { role: "assistant", content: "a1", timestamp: "t1", toolCalls: [] },
    })
    expect(mutations[2]?.args.turn).toMatchObject({ content: "a2" })

    // Local JSONL mirror keeps the git persistence path alive.
    const mirrored = readSession(file)
    expect(mirrored.map((t) => t.content)).toEqual(["a1", "a2"])
  })

  it("uses the local meta line for the session upsert when present", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ type: "meta", mode: "interactive" })}\n`)
    const { client, mutations } = makeMockClient([])
    const store = createSessionStore({
      sessionId: "s1",
      sessionFile: file,
      client,
      tenantId: "owner/repo",
      logger: silentLogger,
    })
    await store.appendTurn({ role: "user", content: "hi", timestamp: "t1" })
    expect(mutations[0]?.args.meta).toMatchObject({ mode: "interactive" })
  })
})
