import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatEvent, EventSink } from "../../src/chat/events.js"
import { buildPrompt, CHAT_SYSTEM_PROMPT, runChatSession } from "../../src/chat/loop.js"
import type { PullFn } from "../../src/chat/loop.js"

class MemSink implements EventSink {
  events: ChatEvent[] = []
  async emit(e: ChatEvent): Promise<void> {
    this.events.push(e)
  }
}

const MODEL = { provider: "anthropic", model: "claude-haiku-4-5-20251001" }

function makePull(script: Array<{ turns: Array<{ role: "user" | "assistant"; content: string; timestamp: string }>; nextSince: number }>): PullFn {
  let i = 0
  return async (_since: number, _timeoutMs: number) => {
    const next = script[i] ?? { turns: [], nextSince: script[script.length - 1]?.nextSince ?? 0 }
    i++
    return next
  }
}

describe("chat/loop buildPrompt", () => {
  it("interleaves turns and tags assistant as the next speaker", () => {
    const prompt = buildPrompt(
      [
        { role: "user", content: "hi", timestamp: "t1" },
        { role: "assistant", content: "hello", timestamp: "t2" },
        { role: "user", content: "what now?", timestamp: "t3" },
      ],
      CHAT_SYSTEM_PROMPT,
    )
    expect(prompt.startsWith("System: ")).toBe(true)
    expect(prompt).toContain("User: hi")
    expect(prompt).toContain("Assistant: hello")
    expect(prompt).toContain("User: what now?")
    expect(prompt.endsWith("Assistant:")).toBe(true)
  })
})

describe("runChatSession", () => {
  let nowMs = 1_000_000

  beforeEach(() => {
    nowMs = 1_000_000
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("processes a user turn, emits chat.message, and exits on idle timeout", async () => {
    const sink = new MemSink()
    const pull = makePull([
      { turns: [{ role: "user", content: "hi", timestamp: "t1" }], nextSince: 1 },
      { turns: [], nextSince: 1 },
      { turns: [], nextSince: 1 }, // idle timeout elapses during this poll
    ])

    const result = await runChatSession({
      sessionId: "s1",
      cwd: "/tmp",
      model: MODEL,
      litellmUrl: null,
      sink,
      pull,
      idleTimeoutMs: 500,
      now: () => {
        const current = nowMs
        nowMs += 1000 // advance 1s per now() call
        return current
      },
      invokeAgent: async () => ({
        outcome: "completed",
        finalText: "  hello back  ",
        ndjsonPath: "/tmp/x.jsonl",
      }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.turnsProcessed).toBe(1)
    expect(result.reason).toBe("idle-timeout")
    const types = sink.events.map((e) => e.event)
    expect(types).toContain("chat.message")
    expect(types).toContain("chat.done")
    const msg = sink.events.find((e) => e.event === "chat.message")
    expect(msg?.payload.content).toBe("hello back")
    expect(msg?.payload.role).toBe("assistant")
  })

  it("emits chat.error and returns 99 when agent throws", async () => {
    const sink = new MemSink()
    const pull = makePull([
      { turns: [{ role: "user", content: "hi", timestamp: "t1" }], nextSince: 1 },
    ])

    const result = await runChatSession({
      sessionId: "s1",
      cwd: "/tmp",
      model: MODEL,
      litellmUrl: null,
      sink,
      pull,
      idleTimeoutMs: 10_000,
      now: () => nowMs,
      invokeAgent: async () => {
        throw new Error("model exploded")
      },
    })

    expect(result.exitCode).toBe(99)
    expect(sink.events.map((e) => e.event)).toEqual(["chat.error"])
    expect(sink.events[0]?.payload.error).toBe("model exploded")
  })

  it("emits chat.error and returns 99 when agent reports failed outcome", async () => {
    const sink = new MemSink()
    const pull = makePull([
      { turns: [{ role: "user", content: "hi", timestamp: "t1" }], nextSince: 1 },
    ])

    const result = await runChatSession({
      sessionId: "s1",
      cwd: "/tmp",
      model: MODEL,
      litellmUrl: null,
      sink,
      pull,
      idleTimeoutMs: 10_000,
      now: () => nowMs,
      invokeAgent: async () => ({
        outcome: "failed",
        finalText: "",
        error: "rate limited",
        ndjsonPath: "/tmp/x.jsonl",
      }),
    })

    expect(result.exitCode).toBe(99)
    expect(sink.events[0]?.payload.error).toBe("rate limited")
  })

  it("emits chat.error and returns 99 when pull throws", async () => {
    const sink = new MemSink()
    const pull: PullFn = async () => {
      throw new Error("ECONNREFUSED")
    }

    const result = await runChatSession({
      sessionId: "s1",
      cwd: "/tmp",
      model: MODEL,
      litellmUrl: null,
      sink,
      pull,
      now: () => nowMs,
      invokeAgent: async () => ({
        outcome: "completed",
        finalText: "x",
        ndjsonPath: "/tmp/x.jsonl",
      }),
    })

    expect(result.exitCode).toBe(99)
    expect(sink.events[0]?.event).toBe("chat.error")
    expect(String(sink.events[0]?.payload.error)).toContain("pull failed")
  })

  it("processes multiple turns sequentially and tracks turnsProcessed", async () => {
    const sink = new MemSink()
    let callIdx = 0
    const pull: PullFn = async () => {
      callIdx++
      if (callIdx === 1) return { turns: [{ role: "user", content: "m1", timestamp: "t1" }], nextSince: 1 }
      if (callIdx === 2) return { turns: [{ role: "user", content: "m2", timestamp: "t2" }], nextSince: 2 }
      return { turns: [], nextSince: 2 } // triggers idle exit on subsequent calls
    }

    const replies = ["reply1", "reply2"]
    let replyIdx = 0

    const result = await runChatSession({
      sessionId: "s1",
      cwd: "/tmp",
      model: MODEL,
      litellmUrl: null,
      sink,
      pull,
      idleTimeoutMs: 500,
      now: () => {
        const current = nowMs
        nowMs += 1000
        return current
      },
      invokeAgent: async () => ({
        outcome: "completed",
        finalText: replies[replyIdx++] ?? "fallback",
        ndjsonPath: "/tmp/x.jsonl",
      }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.turnsProcessed).toBe(2)
    const msgs = sink.events.filter((e) => e.event === "chat.message")
    expect(msgs.map((m) => m.payload.content)).toEqual(["reply1", "reply2"])
  })

  it("hard timeout exits with chat.done reason=hard-timeout", async () => {
    const sink = new MemSink()
    const pull: PullFn = async () => ({ turns: [], nextSince: 0 })
    let t = 0
    const result = await runChatSession({
      sessionId: "s1",
      cwd: "/tmp",
      model: MODEL,
      litellmUrl: null,
      sink,
      pull,
      hardTimeoutMs: 100,
      idleTimeoutMs: 10_000,
      now: () => {
        const current = t
        t += 200 // jump past hardTimeoutMs each tick
        return current
      },
      invokeAgent: async () => ({
        outcome: "completed",
        finalText: "noop",
        ndjsonPath: "/tmp/x.jsonl",
      }),
    })
    expect(result.exitCode).toBe(0)
    expect(result.reason).toBe("hard-timeout")
    expect(sink.events[0]?.payload.reason).toBe("hard-timeout")
  })
})
