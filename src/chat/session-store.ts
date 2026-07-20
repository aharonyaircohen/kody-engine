/**
 * Canonical chat transcript store. Convex conversations are the sole durable
 * authority for every runtime; the engine never creates a parallel transcript.
 */

import type { ConvexHttpClient } from "convex/browser"
import { anyApi } from "convex/server"
import { createConvexClientFromEnv } from "./convex-client.js"
import type { ChatTurn } from "./session.js"

export interface SessionStore {
  backend: "convex"
  readActiveAgent(): Promise<{ slug: string; title: string }>
  readTurns(): Promise<ChatTurn[]>
  appendTurn(turn: ChatTurn): Promise<void>
}

export interface SessionStoreOptions {
  /** Canonical conversation id. */
  sessionId: string
  /** Retained as an ephemeral runner path; never read as transcript storage. */
  sessionFile: string
  tenantId?: string
  client?: ConvexHttpClient | null
  logger?: { info: (msg: string) => void; warn: (msg: string) => void }
}

interface ConversationResult {
  conversation: {
    activeAgent: { slug: string; title: string }
  }
  entries: Array<{
    entryId: string
    seq: number
    entry:
      | {
          kind: "message"
          role: "user" | "assistant"
          content: string
          status: "pending" | "committed" | "failed" | "cancelled"
          createdAt: string
        }
      | {
          kind: "agent-handoff"
          createdAt: string
        }
  }>
}

function currentEpochTurns(result: ConversationResult): ChatTurn[] {
  const ordered = [...result.entries].sort((left, right) => left.seq - right.seq)
  const lastHandoffSeq = ordered.filter((item) => item.entry.kind === "agent-handoff").at(-1)?.seq ?? -1
  return ordered.flatMap((item) =>
    item.seq > lastHandoffSeq &&
    item.entry.kind === "message" &&
    (item.entry.status === "committed" || item.entry.status === "pending")
      ? [
          {
            role: item.entry.role,
            content: item.entry.content,
            timestamp: item.entry.createdAt,
            toolCalls: [],
          },
        ]
      : [],
  )
}

function entryKey(sessionId: string, turn: ChatTurn): string {
  const safeTime = turn.timestamp.replace(/[^a-zA-Z0-9._-]/g, "-")
  return `engine-${sessionId}-${turn.role}-${safeTime}`
}

export function createSessionStore(opts: SessionStoreOptions): SessionStore {
  const logger = opts.logger ?? {
    info: (message) => process.stdout.write(`[kody:chat:store] ${message}\n`),
    warn: (message) => process.stderr.write(`[kody:chat:store] ${message}\n`),
  }
  const client = opts.client !== undefined ? opts.client : createConvexClientFromEnv()
  const tenantId = opts.tenantId ?? process.env.GITHUB_REPOSITORY ?? ""
  if (!client || !tenantId) {
    throw new Error(
      "Canonical Convex conversation storage is required (CONVEX_URL, KODY_SERVICE_KEY, and GITHUB_REPOSITORY)",
    )
  }
  logger.info(`conversation ${opts.sessionId}: using canonical Convex store (tenant ${tenantId})`)

  const read = async (): Promise<ConversationResult> => {
    const result = (await client.query(anyApi.conversations.get, {
      tenantId,
      conversationId: opts.sessionId,
    })) as ConversationResult | null
    if (!result) throw new Error(`Conversation not found: ${opts.sessionId}`)
    return result
  }

  return {
    backend: "convex",
    readActiveAgent: async () => (await read()).conversation.activeAgent,
    readTurns: async () => currentEpochTurns(await read()),
    appendTurn: async (turn) => {
      const result = await read()
      const id = entryKey(opts.sessionId, turn)
      await client.mutation(anyApi.conversations.appendEntry, {
        tenantId,
        conversationId: opts.sessionId,
        entryId: id,
        idempotencyKey: id,
        entry: {
          kind: "message",
          role: turn.role,
          author:
            turn.role === "assistant"
              ? { kind: "agent", ...result.conversation.activeAgent }
              : { kind: "user", actorId: "engine-runtime" },
          content: turn.content,
          status: "committed",
          turnId: id,
          createdAt: turn.timestamp,
        },
      })
    },
  }
}
