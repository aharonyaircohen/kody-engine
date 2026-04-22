import { afterEach, describe, expect, it, vi } from "vitest"
import { createPullClient, parseUrl, PullError } from "../../src/chat/pull.js"

describe("chat/pull parseUrl", () => {
  it("extracts token and strips trailing slash", () => {
    const parsed = parseUrl("https://dash.example/?token=abc")
    expect(parsed.origin).toBe("https://dash.example")
    expect(parsed.token).toBe("abc")
  })

  it("returns null token when absent", () => {
    const parsed = parseUrl("https://dash.example")
    expect(parsed.origin).toBe("https://dash.example")
    expect(parsed.token).toBeNull()
  })

  it("preserves a non-root path on the origin", () => {
    const parsed = parseUrl("https://dash.example/prefix?token=abc")
    expect(parsed.origin).toBe("https://dash.example/prefix")
    expect(parsed.token).toBe("abc")
  })

  it("falls back to raw string on malformed input", () => {
    const parsed = parseUrl("not-a-url")
    expect(parsed.origin).toBe("not-a-url")
    expect(parsed.token).toBeNull()
  })
})

describe("chat/pull createPullClient", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("throws when no token is available", () => {
    expect(() => createPullClient({ baseUrl: "https://dash.example", sessionId: "s1" })).toThrow(PullError)
  })

  it("builds the right URL and sends Bearer auth", async () => {
    const fetchMock: typeof fetch = vi.fn(async () =>
      new Response(JSON.stringify({ turns: [], nextSince: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch
    const pull = createPullClient({
      baseUrl: "https://dash.example?token=tk",
      sessionId: "s1",
      fetchFn: fetchMock,
    })

    await pull(5, 25_000)

    const mock = fetchMock as unknown as ReturnType<typeof vi.fn>
    expect(mock).toHaveBeenCalledTimes(1)
    const call = mock.mock.calls[0]!
    const url = String(call[0])
    const init = call[1] as RequestInit
    expect(url).toBe("https://dash.example/api/kody/chat/pull?sessionId=s1&since=5&timeoutMs=25000&token=tk")
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tk")
  })

  it("parses the dashboard response body", async () => {
    const fetchMock: typeof fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          turns: [{ role: "user", content: "hi", timestamp: "t1" }],
          nextSince: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch
    const pull = createPullClient({
      baseUrl: "https://dash.example?token=tk",
      sessionId: "s1",
      fetchFn: fetchMock,
    })
    const res = await pull(0, 25_000)
    expect(res.nextSince).toBe(1)
    expect(res.turns).toEqual([{ role: "user", content: "hi", timestamp: "t1" }])
  })

  it("throws PullError on non-2xx with the status code", async () => {
    const fetchMock: typeof fetch = vi.fn(async () => new Response("bad", { status: 401 })) as unknown as typeof fetch
    const pull = createPullClient({
      baseUrl: "https://dash.example?token=tk",
      sessionId: "s1",
      fetchFn: fetchMock,
    })
    await expect(pull(0, 25_000)).rejects.toMatchObject({ status: 401 })
  })
})
