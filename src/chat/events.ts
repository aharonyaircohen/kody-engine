/**
 * Chat event emission — file JSONL + optional HTTP push, composed via Tee.
 *
 * Events are what the Kody-Dashboard SSE stream consumes. The FileSink makes
 * them durable (committed back via git) so the dashboard's GitHub-poll path
 * can rehydrate a session on reconnect; the HttpSink gives real-time push
 * when the dashboard URL + inline token are provided.
 */

import * as fs from "node:fs"
import * as path from "node:path"

export interface ChatEvent {
  event: "chat.message" | "chat.tool" | "chat.thinking" | "chat.done" | "chat.error"
  payload: Record<string, unknown>
  runId: string
  emittedAt: string
}

export interface EventSink {
  emit(event: ChatEvent): Promise<void>
}

export function eventsFilePath(cwd: string, sessionId: string): string {
  return path.join(cwd, ".kody", "events", `${sessionId}.jsonl`)
}

export class FileSink implements EventSink {
  constructor(private readonly file: string) {}
  async emit(event: ChatEvent): Promise<void> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`)
  }
}

/**
 * Posts each event to the dashboard ingest endpoint. The URL is expected to
 * carry an inline `?token=...` so the dashboard can verify the session HMAC
 * without a shared DB lookup. The sessionId is appended as a query param so
 * the endpoint can route events to the right SSE stream.
 *
 * Best-effort: swallowed errors won't fail the chat turn. The FileSink still
 * persists the event and the dashboard's GitHub-poll picks it up.
 */
export class HttpSink implements EventSink {
  constructor(
    private readonly baseUrl: string,
    private readonly sessionId: string,
    private readonly logger: { warn: (msg: string) => void } = {
      warn: (m) => process.stderr.write(`[kody:chat] ${m}\n`),
    },
  ) {}

  async emit(event: ChatEvent): Promise<void> {
    const url = withSessionParam(this.baseUrl, this.sessionId)
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        this.logger.warn(`HttpSink POST ${url} → ${res.status}`)
      }
    } catch (err) {
      this.logger.warn(`HttpSink POST ${url} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export class TeeSink implements EventSink {
  constructor(private readonly sinks: EventSink[]) {}
  async emit(event: ChatEvent): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.emit(event)))
  }
}

export function withSessionParam(baseUrl: string, sessionId: string): string {
  const joiner = baseUrl.includes("?") ? "&" : "?"
  return `${baseUrl}${joiner}sessionId=${encodeURIComponent(sessionId)}`
}

export function makeRunId(sessionId: string, suffix: string): string {
  return `chat-${sessionId}-${suffix}`
}
