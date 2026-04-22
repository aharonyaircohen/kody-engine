import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ChatEvent, EventSink } from "../../src/chat/events.js"
import { buildPrompt, CHAT_SYSTEM_PROMPT, runChatTurn } from "../../src/chat/loop.js"
import { appendTurn, readSession } from "../../src/chat/session.js"

class MemSink implements EventSink {
  events: ChatEvent[] = []
  async emit(e: ChatEvent): Promise<void> {
    this.events.push(e)
  }
}

const MODEL = { provider: "anthropic", model: "claude-haiku-4-5-20251001" }

describe("chat/loop", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody2-chat-loop-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("buildPrompt interleaves turns and tags assistant as the next speaker", () => {
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

  it("emits chat.error and returns 64 when session is empty", async () => {
    const sessionFile = path.join(tmp, "s.jsonl")
    const sink = new MemSink()
    const res = await runChatTurn({
      sessionId: "s1",
      sessionFile,
      cwd: tmp,
      model: MODEL,
      litellmUrl: null,
      sink,
      invokeAgent: async () => {
        throw new Error("should not run agent on empty session")
      },
    })
    expect(res.exitCode).toBe(64)
    expect(sink.events.map((e) => e.event)).toEqual(["chat.error"])
  })

  it("emits chat.error and returns 64 when last turn is assistant", async () => {
    const sessionFile = path.join(tmp, "s.jsonl")
    appendTurn(sessionFile, { role: "user", content: "hi", timestamp: "t1" })
    appendTurn(sessionFile, { role: "assistant", content: "hello", timestamp: "t2" })
    const sink = new MemSink()
    const res = await runChatTurn({
      sessionId: "s1",
      sessionFile,
      cwd: tmp,
      model: MODEL,
      litellmUrl: null,
      sink,
      invokeAgent: async () => {
        throw new Error("should not run agent when assistant already replied")
      },
    })
    expect(res.exitCode).toBe(64)
    expect(sink.events.map((e) => e.event)).toEqual(["chat.error"])
  })

  it("runs the agent, appends reply, emits message + done", async () => {
    const sessionFile = path.join(tmp, "s.jsonl")
    appendTurn(sessionFile, { role: "user", content: "hi", timestamp: "t1" })
    const sink = new MemSink()
    const res = await runChatTurn({
      sessionId: "s1",
      sessionFile,
      cwd: tmp,
      model: MODEL,
      litellmUrl: null,
      sink,
      invokeAgent: async () => ({
        outcome: "completed",
        finalText: "  hello back  ",
        ndjsonPath: "/tmp/x.jsonl",
      }),
    })
    expect(res.exitCode).toBe(0)
    expect(res.reply).toBe("hello back")
    const turns = readSession(sessionFile)
    expect(turns).toHaveLength(2)
    expect(turns[1]?.role).toBe("assistant")
    expect(turns[1]?.content).toBe("hello back")
    expect(sink.events.map((e) => e.event)).toEqual(["chat.message", "chat.done"])
    expect(sink.events[0]?.payload.content).toBe("hello back")
  })

  it("emits chat.error and returns 99 when agent throws", async () => {
    const sessionFile = path.join(tmp, "s.jsonl")
    appendTurn(sessionFile, { role: "user", content: "hi", timestamp: "t1" })
    const sink = new MemSink()
    const res = await runChatTurn({
      sessionId: "s1",
      sessionFile,
      cwd: tmp,
      model: MODEL,
      litellmUrl: null,
      sink,
      invokeAgent: async () => {
        throw new Error("model exploded")
      },
    })
    expect(res.exitCode).toBe(99)
    expect(sink.events.map((e) => e.event)).toEqual(["chat.error"])
    expect(sink.events[0]?.payload.error).toBe("model exploded")
    expect(readSession(sessionFile)).toHaveLength(1)
  })

  it("emits chat.error and returns 99 when agent reports failed outcome", async () => {
    const sessionFile = path.join(tmp, "s.jsonl")
    appendTurn(sessionFile, { role: "user", content: "hi", timestamp: "t1" })
    const sink = new MemSink()
    const res = await runChatTurn({
      sessionId: "s1",
      sessionFile,
      cwd: tmp,
      model: MODEL,
      litellmUrl: null,
      sink,
      invokeAgent: async () => ({
        outcome: "failed",
        finalText: "",
        error: "rate limited",
        ndjsonPath: "/tmp/x.jsonl",
      }),
    })
    expect(res.exitCode).toBe(99)
    expect(sink.events[0]?.payload.error).toBe("rate limited")
  })
})
