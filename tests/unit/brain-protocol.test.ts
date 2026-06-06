/**
 * Tests for the Brain SSE ↔ OpenAI SSE translation adapter.
 *
 * The adapter is the only thing standing between the dashboard (which speaks
 * Brain SSE) and Hermes (which speaks OpenAI SSE). Translation correctness
 * is the whole point of having a proxy in the engine.
 */

import { describe, expect, it } from "vitest"
import { brainToOpenAIRequest, translateOpenAISseToBrain } from "../../src/servers/brain-protocol.js"

describe("brainToOpenAIRequest", () => {
  it("translates a Brain chat message to OpenAI Chat Completions", () => {
    const out = brainToOpenAIRequest({ chatId: "c-1", message: "hello" })
    expect(out).toEqual({
      model: "anthropic/claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })
  })

  it("honors a custom model", () => {
    const out = brainToOpenAIRequest({ chatId: "c-1", message: "x", model: "openai/gpt-4" })
    expect(out.model).toBe("openai/gpt-4")
  })
})

describe("translateOpenAISseToBrain", () => {
  function collect(events: string[]): { feed: (s: string) => void; end: () => void } {
    return translateOpenAISseToBrain({
      chatId: "c-1",
      write: (line) => events.push(line),
    })
  }

  function parseEvents(lines: string[]) {
    return lines.filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)))
  }

  it("translates a single OpenAI content delta to a Brain text event with seq=1", () => {
    const lines: string[] = []
    const t = collect(lines)
    t.feed('data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n')
    t.end()
    const events = parseEvents(lines)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "text", text: "hi", chatId: "c-1", seq: 1 })
  })

  it("accumulates multiple deltas into separate text events with monotonic seq", () => {
    const lines: string[] = []
    const t = collect(lines)
    t.feed('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
    t.feed('data: {"choices":[{"delta":{"content":"b"}}]}\n\n')
    t.feed('data: {"choices":[{"delta":{"content":"c"}}]}\n\n')
    t.end()
    const events = parseEvents(lines)
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(events.map((e) => e.text)).toEqual(["a", "b", "c"])
  })

  it("emits a done event when the upstream stream closes with [DONE]", () => {
    const lines: string[] = []
    const t = collect(lines)
    t.feed('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')
    t.feed("data: [DONE]\n\n")
    t.end()
    const events = parseEvents(lines)
    expect(events.at(-1)).toMatchObject({ type: "done", chatId: "c-1" })
  })

  it("emits a done event when the upstream sends finish_reason=stop", () => {
    const lines: string[] = []
    const t = collect(lines)
    t.feed('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    t.end()
    const events = parseEvents(lines)
    expect(events.at(-1)).toMatchObject({ type: "done", chatId: "c-1" })
  })

  it("emits no error event when the upstream stream ends without done", () => {
    // The HTTP layer in the proxy closes the SSE connection cleanly when
    // the upstream stream ends. The dashboard interprets stream-end as a
    // normal completion (not a failure). An extra `error` event here would
    // confuse the dashboard.
    const lines: string[] = []
    const t = collect(lines)
    t.end()
    const events = parseEvents(lines)
    expect(events).toHaveLength(0)
  })

  it("handles chunks split across feeds (incomplete line buffering)", () => {
    const lines: string[] = []
    const t = collect(lines)
    // First half of an SSE event
    t.feed('data: {"choices":[{"delta":{"conte')
    t.feed('nt":"hello"}}]}\n\n')
    t.end()
    const events = parseEvents(lines)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "text", text: "hello" })
  })

  it("ignores SSE comment lines", () => {
    const lines: string[] = []
    const t = collect(lines)
    t.feed(": keepalive comment\n\n")
    t.feed('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')
    t.end()
    const events = parseEvents(lines)
    expect(events).toHaveLength(1)
    expect(events[0].text).toBe("x")
  })

  it("skips malformed JSON without crashing", () => {
    const lines: string[] = []
    const t = collect(lines)
    t.feed("data: {not valid json}\n\n")
    t.feed('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')
    t.end()
    const events = parseEvents(lines)
    expect(events).toHaveLength(1)
    expect(events[0].text).toBe("x")
  })

  // ─── tool_calls translation (Gap 1) ──────────────────────────────────────

  it("emits a Brain tool_use event when OpenAI sends a complete tool_call (single chunk)", () => {
    const lines: string[] = []
    const t = collect(lines)
    // OpenAI streams tool_calls as deltas with the same `index`. The first
    // chunk carries id+name; subsequent chunks carry args fragments. We
    // simulate a single-chunk complete tool call followed by finish_reason.
    t.feed(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"fetch_repo","delta":"{\\"repo\\":\\"A-Guy/test\\"}"}}]},"finish_reason":null}]}\n\n',
    )
    t.feed('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n')
    t.end()
    const events = parseEvents(lines)
    const toolUse = events.find((e) => e.type === "tool_use")
    expect(toolUse).toMatchObject({
      type: "tool_use",
      name: "fetch_repo",
      chatId: "c-1",
    })
    expect((toolUse as { input: { repo: string } }).input).toEqual({ repo: "A-Guy/test" })
  })

  it("accumulates tool_call args across multiple SSE chunks", () => {
    const lines: string[] = []
    const t = collect(lines)
    // Real OpenAI streams args one fragment at a time. We split a JSON
    // object across three chunks and expect the parser to reassemble.
    // Note: the `delta` field in each chunk is itself a JSON-encoded
    // string — when JSON-parsed, each `delta` becomes a fragment of the
    // full JSON args object.
    t.feed(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"list_prs"}}]},"finish_reason":null}]}\n\n',
    )
    t.feed(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"delta":"{\\"state\\":"}}]},"finish_reason":null}]}\n\n',
    )
    t.feed(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"delta":"\\"open\\"}"}}]},"finish_reason":null}]}\n\n',
    )
    t.feed('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n')
    t.end()
    const events = parseEvents(lines)
    const toolUse = events.find((e) => e.type === "tool_use")
    expect(toolUse).toMatchObject({ type: "tool_use", name: "list_prs" })
    expect((toolUse as { input: { state: string } }).input).toEqual({ state: "open" })
  })

  it("handles multiple parallel tool_calls in the same stream (different indexes)", () => {
    const lines: string[] = []
    const t = collect(lines)
    // Two tool calls with indexes 0 and 1, emitted in interleaved chunks.
    t.feed(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"tool_a"}}]}}]}\n\n',
    )
    t.feed(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"tool_b"}}]}}]}\n\n',
    )
    t.feed('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"delta":"{}"}}]}}]}\n\n')
    t.feed('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"delta":"{}"}}]}}]}\n\n')
    t.feed('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n')
    t.end()
    const events = parseEvents(lines)
    const toolUses = events.filter((e) => e.type === "tool_use")
    expect(toolUses).toHaveLength(2)
    const names = toolUses.map((e) => (e as { name: string }).name).sort()
    expect(names).toEqual(["tool_a", "tool_b"])
  })

  it("emits a partial-input tool_use when args JSON never completes", () => {
    // If the stream ends mid-args (the upstream crashes or the args JSON
    // never closes), we emit a tool_use with `_partial` so the consumer
    // sees the tool was invoked but the args are incomplete.
    const lines: string[] = []
    const t = collect(lines)
    t.feed(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"p","function":{"name":"ping","delta":"{\\"x\\":"}}]}}]}\n\n',
    )
    t.feed('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n')
    t.end()
    const events = parseEvents(lines)
    const toolUse = events.find((e) => e.type === "tool_use")
    expect(toolUse).toBeDefined()
    expect((toolUse as { input: { _partial: string } }).input._partial).toContain("x")
  })

  it("falls back to name='tool' when no function name is provided", () => {
    const lines: string[] = []
    const t = collect(lines)
    t.feed('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"delta":"{}"}}]}}]}\n\n')
    t.feed('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n')
    t.end()
    const events = parseEvents(lines)
    const toolUse = events.find((e) => e.type === "tool_use")
    expect((toolUse as { name: string }).name).toBe("tool")
  })
})
