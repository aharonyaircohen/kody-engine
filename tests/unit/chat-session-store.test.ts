import type { ConvexHttpClient } from "convex/browser"
import { describe, expect, it, vi } from "vitest"
import { createSessionStore } from "../../src/chat/session-store.js"

const silentLogger = { info: () => {}, warn: () => {} }

function mockClient(result: unknown) {
  const query = vi.fn(async () => result)
  const mutation = vi.fn(async () => "entry-id")
  return {
    client: { query, mutation } as unknown as ConvexHttpClient,
    query,
    mutation,
  }
}

describe("chat/session-store", () => {
  it("fails closed without canonical storage", () => {
    expect(() =>
      createSessionStore({
        sessionId: "c1",
        sessionFile: "/tmp/unused.jsonl",
        client: null,
        tenantId: "owner/repo",
        logger: silentLogger,
      }),
    ).toThrow("Canonical Convex conversation storage is required")
  })

  it("reads only the current agent epoch in exact sequence order", async () => {
    const { client, query } = mockClient({
      conversation: { activeAgent: { slug: "ceo", title: "CEO" } },
      entries: [
        {
          entryId: "m2",
          seq: 1,
          entry: {
            kind: "message",
            role: "assistant",
            content: "old UX answer",
            status: "committed",
            createdAt: "t2",
          },
        },
        {
          entryId: "h1",
          seq: 2,
          entry: { kind: "agent-handoff", createdAt: "t3" },
        },
        {
          entryId: "m3",
          seq: 3,
          entry: {
            kind: "message",
            role: "user",
            content: "business risk?",
            status: "committed",
            createdAt: "t4",
          },
        },
        {
          entryId: "m1",
          seq: 0,
          entry: {
            kind: "message",
            role: "user",
            content: "review UX",
            status: "committed",
            createdAt: "t1",
          },
        },
      ],
    })
    const store = createSessionStore({
      sessionId: "c1",
      sessionFile: "/tmp/unused.jsonl",
      client,
      tenantId: "owner/repo",
      logger: silentLogger,
    })

    await expect(store.readTurns()).resolves.toEqual([
      expect.objectContaining({ role: "user", content: "business risk?" }),
    ])
    await expect(store.readActiveAgent()).resolves.toEqual({
      slug: "ceo",
      title: "CEO",
    })
    expect(query).toHaveBeenCalledWith(expect.anything(), {
      tenantId: "owner/repo",
      conversationId: "c1",
    })
  })

  it("appends an idempotent typed assistant entry under the active agent", async () => {
    const { client, mutation } = mockClient({
      conversation: { activeAgent: { slug: "ceo", title: "CEO" } },
      entries: [],
    })
    const store = createSessionStore({
      sessionId: "c1",
      sessionFile: "/tmp/unused.jsonl",
      client,
      tenantId: "owner/repo",
      logger: silentLogger,
    })
    await store.appendTurn({
      role: "assistant",
      content: "conversion risk",
      timestamp: "2026-07-20T10:00:00.000Z",
    })

    expect(mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: "owner/repo",
        conversationId: "c1",
        entry: expect.objectContaining({
          role: "assistant",
          author: { kind: "agent", slug: "ceo", title: "CEO" },
        }),
      }),
    )
  })
})
