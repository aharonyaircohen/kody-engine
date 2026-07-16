/**
 * Session transcript store — Convex-first with legacy JSONL fallback.
 *
 * The dashboard dual-writes chat transcripts to Convex (chatSessions /
 * chatTurns) and to `sessions/<id>.jsonl` in the GitHub state repo. This
 * store lets the engine read/append via Convex when CONVEX_URL +
 * KODY_SERVICE_KEY are configured (Actions secrets), and falls back to the
 * local JSONL file otherwise.
 *
 * The Convex-backed store still mirrors appends into the local JSONL file so
 * the existing git persistence (state-repo commits, dashboard git fallback)
 * keeps working during the transition. Once the engine's Actions secrets are
 * set everywhere, the dashboard's state-repo JSONL write can retire.
 */

import type { ConvexHttpClient } from "convex/browser"
import { anyApi } from "convex/server"
import { createConvexClientFromEnv } from "./convex-client.js"
import type { ChatTurn } from "./session.js"
import { appendTurn, readMeta, readSession } from "./session.js"

export interface SessionStore {
  backend: "convex" | "jsonl"
  readTurns(): Promise<ChatTurn[]>
  appendTurn(turn: ChatTurn): Promise<void>
}

export interface SessionStoreOptions {
  sessionId: string
  /** Local JSONL cache path (`<cwd>/.kody/sessions/<id>.jsonl`). */
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
 * Build the session store for a chat run. Uses Convex when a client is
 * available (CONVEX_URL set), the legacy JSONL file otherwise — and logs
 * which path was chosen so runs are diagnosable from Actions logs.
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
    logger.warn(`session ${opts.sessionId}: CONVEX_URL set but no tenant (GITHUB_REPOSITORY unset) — using JSONL`)
  } else {
    logger.info(`session ${opts.sessionId}: CONVEX_URL unset — using legacy state-repo JSONL store`)
  }
  return createJsonlStore(opts.sessionFile)
}

function createJsonlStore(sessionFile: string): SessionStore {
  return {
    backend: "jsonl",
    readTurns: async () => readSession(sessionFile),
    appendTurn: async (turn) => {
      appendTurn(sessionFile, turn)
    },
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

  return {
    backend: "convex",
    readTurns: async () => {
      const docs = (await client.query(anyApi.chatTurns.list, { tenantId, sessionId })) as ConvexTurnDoc[]
      return [...docs]
        .sort((a, b) => a.seq - b.seq)
        .map((doc) => doc.turn)
        .filter(isChatTurn)
    },
    appendTurn: async (turn) => {
      const normalized: ChatTurn = {
        role: turn.role,
        content: turn.content,
        timestamp: turn.timestamp,
        toolCalls: turn.toolCalls ?? [],
      }
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
          logger.warn(`session ${sessionId}: chatSessions.upsert failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      await client.mutation(anyApi.chatTurns.append, { tenantId, sessionId, turn: normalized })
      // Mirror to the local JSONL so git persistence and dashboards on the
      // legacy path keep seeing the transcript during the transition.
      try {
        appendTurn(sessionFile, normalized)
      } catch (err) {
        logger.warn(`session ${sessionId}: local JSONL mirror failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}
