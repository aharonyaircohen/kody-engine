/**
 * Chat event emission — real-time HTTP push to the dashboard ingest endpoint.
 *
 * Chat is ephemeral: no git persistence, no FileSink. The runner POSTs events
 * straight to /api/kody/events/ingest authenticated by the HMAC session
 * token that the dashboard passed inline as `?token=...` in DASHBOARD_URL.
 */

import { parseUrl } from "./pull.js"

export interface ChatEvent {
  event: "chat.message" | "chat.tool" | "chat.thinking" | "chat.done" | "chat.error"
  payload: Record<string, unknown>
  runId: string
  emittedAt: string
}

export interface EventSink {
  emit(event: ChatEvent): Promise<void>
}

/**
 * Posts each event to the dashboard ingest endpoint. Base URL may include
 * an inline `?token=...`. The sessionId is appended per request; token is
 * sent as a Bearer header.
 */
export class HttpSink implements EventSink {
  private readonly origin: string
  private readonly token: string

  constructor(
    baseUrl: string,
    private readonly sessionId: string,
    token?: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly logger: { warn: (msg: string) => void } = {
      warn: (m) => process.stderr.write(`[kody2:chat] ${m}\n`),
    },
  ) {
    const parsed = parseUrl(baseUrl)
    this.origin = parsed.origin
    const resolved = token ?? parsed.token
    if (!resolved) {
      throw new Error("HttpSink: session token not provided (expected inline ?token= in baseUrl)")
    }
    this.token = resolved
  }

  async emit(event: ChatEvent): Promise<void> {
    const url = new URL(this.origin)
    url.pathname = "/api/kody/events/ingest"
    url.searchParams.set("sessionId", this.sessionId)
    url.searchParams.set("token", this.token)
    try {
      const res = await this.fetchFn(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        this.logger.warn(`HttpSink POST ${url.pathname} → ${res.status}`)
      }
    } catch (err) {
      this.logger.warn(
        `HttpSink POST ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

export class TeeSink implements EventSink {
  constructor(private readonly sinks: EventSink[]) {}
  async emit(event: ChatEvent): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.emit(event)))
  }
}

export function makeRunId(sessionId: string, suffix: string): string {
  return `chat-${sessionId}-${suffix}`
}
