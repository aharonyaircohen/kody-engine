/**
 * HTTP pull client for the dashboard's /api/kody/chat/pull endpoint.
 *
 * Auth is the HMAC session token carried inline in `dashboardUrl` (parsed
 * off the URL at runner startup). We re-apply it on every request as a
 * Bearer header so the dashboard can verify the session without a DB hop.
 */

export interface PulledTurn {
  role: "user" | "assistant"
  content: string
  timestamp: string
}

export interface PullResponse {
  turns: PulledTurn[]
  nextSince: number
}

export interface PullClientOptions {
  /** Base URL of the dashboard (with optional inline ?token=). */
  baseUrl: string
  sessionId: string
  /** Override the token if not embedded in baseUrl. */
  token?: string
  /** Seam for tests. */
  fetchFn?: typeof fetch
}

export class PullError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = "PullError"
  }
}

/**
 * Build a PullClient whose `pull(since, timeoutMs)` method matches the
 * PullFn signature in chat/loop.ts.
 */
export function createPullClient(opts: PullClientOptions): (since: number, timeoutMs: number) => Promise<PullResponse> {
  const fetchFn = opts.fetchFn ?? fetch
  const parsed = parseUrl(opts.baseUrl)
  const token = opts.token ?? parsed.token
  if (!token) {
    throw new PullError("session token not provided (expected inline ?token= in dashboardUrl)")
  }

  return async function pull(since: number, timeoutMs: number): Promise<PullResponse> {
    const url = new URL(parsed.origin)
    url.pathname = "/api/kody/chat/pull"
    url.searchParams.set("sessionId", opts.sessionId)
    url.searchParams.set("since", String(since))
    url.searchParams.set("timeoutMs", String(timeoutMs))
    url.searchParams.set("token", token)

    // Long-poll: dashboard resolves in <= timeoutMs. Fail-open slightly longer
    // so a server-side 25s poll isn't truncated by a 24s client abort.
    const abort = AbortSignal.timeout(timeoutMs + 10_000)

    const res = await fetchFn(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: abort,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new PullError(`pull ${url.pathname} → ${res.status}: ${body.slice(0, 200)}`, res.status)
    }
    const data = (await res.json()) as PullResponse
    return data
  }
}

export function parseUrl(baseUrl: string): { origin: string; token: string | null } {
  try {
    const u = new URL(baseUrl)
    const token = u.searchParams.get("token")
    const origin = `${u.protocol}//${u.host}${u.pathname !== "/" ? u.pathname : ""}`.replace(/\/$/, "")
    return { origin: origin || u.origin, token }
  } catch {
    return { origin: baseUrl, token: null }
  }
}
