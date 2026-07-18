/**
 * Session transcript store. Convex is the durable authority; local JSONL is
 * ephemeral runtime storage for direct development and tests only.
 */

import type { ConvexHttpClient } from "convex/browser"
import { anyApi } from "convex/server"
import { createConvexClientFromEnv } from "./convex-client.js"
import type { ChatTurn } from "./session.js"
import { appendTurn, readMeta, readSession } from "./session.js"

export interface SessionStore {
  backend: "convex" | "local"
  readTurns(): Promise<ChatTurn[]>
  appendTurn(turn: ChatTurn): Promise<void>
}

export interface SessionStoreOptions {
  sessionId: string
  /** Ephemeral runtime JSONL path. */
  sessionFile: string
  /** Convex tenant scope — `owner/repo`. Defaults to GITHUB_REPOSITORY. */
  tenantId?: string
  /** Test seam — overrides the env-derived client. */
  client?: ConvexHttpClient | null
  logger?: { info: (msg: string) => void; warn: (msg: string) => void }
}

interface ConvexTurnDoc {
  seq: number
  turn: ChatTurn
}

function isChatTurn(value: unknown): value is ChatTurn {
  if (!value || typeof value !== "object") return false
  const t = value as Partial<ChatTurn>
  return (t.role === "user" || t.role === "assistant") && typeof t.content === "string"
}

/**
 * Build the session store for a chat run.
 */
export function createSessionStore(opts: SessionStoreOptions): SessionStore {
  const logger = opts.logger ?? {
    info: (m) => process.stdout.write(`[kody:chat:store] ${m}\n`),
    warn: (m) => process.stderr.write(`[kody:chat:store] ${m}\n`),
  }
  const client = opts.client !== undefined ? opts.client : createConvexClientFromEnv()
  const tenantId = opts.tenantId ?? process.env.GITHUB_REPOSITORY ?? ""

  if (client && tenantId) {
    logger.info(`session ${opts.sessionId}: using Convex transcript store (tenant ${tenantId})`)
    return createConvexStore({
      client,
      tenantId,
      sessionId: opts.sessionId,
      sessionFile: opts.sessionFile,
      logger,
    })
  }

  if (client && !tenantId) {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error("Convex chat backend requires GITHUB_REPOSITORY in GitHub Actions")
    }
    logger.warn(`session ${opts.sessionId}: Convex configured without a tenant; using local runtime storage`)
  } else {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error("Convex chat backend is required in GitHub Actions (CONVEX_URL and KODY_SERVICE_KEY)")
    }
    logger.info(`session ${opts.sessionId}: backend unavailable; using local runtime storage`)
  }
  return createLocalStore(opts.sessionFile)
}

function createLocalStore(sessionFile: string): SessionStore {
  return {
    backend: "local",
    readTurns: async () => readSession(sessionFile),
    appendTurn: async (turn) => {
      appendTurn(sessionFile, turn)
    },
  }
}

function normalizeTurn(turn: ChatTurn): ChatTurn {
  return {
    role: turn.role,
    content: turn.content,
    timestamp: turn.timestamp,
    toolCalls: turn.toolCalls ?? [],
  }
}

function createConvexStore(args: {
  client: ConvexHttpClient
  tenantId: string
  sessionId: string
  sessionFile: string
  logger: { info: (msg: string) => void; warn: (msg: string) => void }
}): SessionStore {
  const { client, tenantId, sessionId, sessionFile, logger } = args
  let sessionUpserted = false

  const appendToConvex = async (turn: ChatTurn): Promise<void> => {
    // Ensure the session record exists once per run (sessions seeded
    // before this store existed have turns but no chatSessions row). The
    // meta comes from the local JSONL meta line, matching how the
    // dashboard records it; upsert only patches meta+updatedAt, so
    // re-running is harmless.
    if (!sessionUpserted) {
      try {
        const meta = readMeta(sessionFile) ?? { type: "meta", mode: "one-shot" }
        await client.mutation(anyApi.chatSessions.upsert, {
          tenantId,
          sessionId,
          meta,
          updatedAt: new Date().toISOString(),
        })
        sessionUpserted = true
      } catch (err) {
        logger.warn(
          `session ${sessionId}: chatSessions.upsert failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    await client.mutation(anyApi.chatTurns.append, { tenantId, sessionId, turn })
  }

  return {
    backend: "convex",
    readTurns: async () => {
      const docs = (await client.query(anyApi.chatTurns.list, { tenantId, sessionId })) as ConvexTurnDoc[]
      const convexTurns = [...docs]
        .sort((a, b) => a.seq - b.seq)
        .map((doc) => doc.turn)
        .filter(isChatTurn)
      if (convexTurns.length > 0) return convexTurns
      const tail = readSession(sessionFile).map(normalizeTurn)
      if (tail.length === 0) return convexTurns
      logger.info(`session ${sessionId}: importing ${tail.length} runtime turn(s) into Convex`)
      for (const turn of tail) {
        await appendToConvex(turn)
      }
      return tail
    },
    appendTurn: async (turn) => {
      const normalized = normalizeTurn(turn)
      await appendToConvex(normalized)
    },
  }
}
