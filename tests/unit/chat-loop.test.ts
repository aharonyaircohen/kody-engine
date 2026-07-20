import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ChatEvent, EventSink } from "../../src/chat/events.js"
import { buildPrompt, runChatTurn, shouldWriteTaskArtifacts } from "../../src/chat/loop.js"
import { appendTurn, readSession } from "../../src/chat/session.js"
import type { SessionStore } from "../../src/chat/session-store.js"

class MemSink implements EventSink {
  events: ChatEvent[] = []
  async emit(e: ChatEvent): Promise<void> {
    this.events.push(e)
  }
}

const MODEL = { provider: "anthropic", model: "claude-haiku-4-5-20251001" }

function testStore(sessionFile: string): SessionStore {
  return {
    backend: "convex",
    readMode: async () => "one-shot",
    readActiveAgent: async () => ({ slug: "kody", title: "Kody" }),
    readTurns: async () => readSession(sessionFile),
    appendTurn: async (turn) => appendTurn(sessionFile, turn),
  }
}

describe("chat/loop", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-chat-loop-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("does not add engine artifact instructions to Codex chat turns", () => {
    expect(shouldWriteTaskArtifacts("codex-app-server")).toBe(false)
    expect(shouldWriteTaskArtifacts("native")).toBe(true)
    expect(shouldWriteTaskArtifacts(undefined)).toBe(true)
  })

  it("buildPrompt interleaves turns and tags assistant as the next speaker", () => {
    const prompt = buildPrompt([
      { role: "user", content: "hi", timestamp: "t1" },
      { role: "assistant", content: "hello", timestamp: "t2" },
      { role: "user", content: "what now?", timestamp: "t3" },
    ])
    expect(prompt).toContain("User: hi")
    expect(prompt).toContain("Assistant: hello")
    expect(prompt).toContain("User: what now?")
    expect(prompt.endsWith("Assistant:")).toBe(true)
    // System instructions are passed via systemPromptAppend, not embedded here.
    expect(prompt.includes("System:")).toBe(false)
  })

  it("emits chat.error and returns 64 when session is empty", async () => {
    const sessionFile = path.join(tmp, "s.jsonl")
    const sink = new MemSink()
    const res = await runChatTurn({
      sessionId: "s1",
      sessionFile,
      store: testStore(sessionFile),
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
      store: testStore(sessionFile),
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
      store: testStore(sessionFile),
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

  it("routes OpenAI-protocol Brain turns through LiteLLM chat completions", async () => {
    const sessionFile = path.join(tmp, "s.jsonl")
    appendTurn(sessionFile, { role: "user", content: "hi", timestamp: "t1" })
    const sink = new MemSink()
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const res = await runChatTurn({
      sessionId: "s1",
      sessionFile,
      store: testStore(sessionFile),
      cwd: tmp,
      model: { provider: "custom", model: "MiniMax-M3", protocol: "openai", spec: "minimax/MiniMax-M3" },
      litellmUrl: "http://localhost:4000",
      sink,
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        })
        return new Response(JSON.stringify({ choices: [{ message: { content: "  OK  " } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
      invokeAgent: async () => {
        throw new Error("openai protocol should not use Claude agent")
      },
    })
    expect(res.exitCode).toBe(0)
    expect(res.reply).toBe("OK")
    expect(calls[0]?.url).toBe("http://localhost:4000/v1/chat/completions")
    expect(calls[0]?.body.model).toBe("minimax/MiniMax-M3")
    expect(sink.events.map((e) => e.event)).toEqual(["chat.message", "chat.done"])
    expect(readSession(sessionFile)[1]?.content).toBe("OK")
  })

  it("injects a selected agent identity into Brain chat prompts", async () => {
    const sessionFile = path.join(tmp, "s.jsonl")
    appendTurn(sessionFile, { role: "user", content: "who are you?", timestamp: "t1" })
    const sink = new MemSink()
    const calls: Array<{ body: Record<string, unknown> }> = []
    const res = await runChatTurn({
      sessionId: "s1",
      sessionFile,
      store: testStore(sessionFile),
      cwd: tmp,
      model: { provider: "custom", model: "MiniMax-M3", protocol: "openai", spec: "minimax/MiniMax-M3" },
      litellmUrl: "http://localhost:4000",
      sink,
      agentIdentity: {
        slug: "repo-brain",
        body: "You are the Repo Brain. Stay inside the selected repository.",
      },
      fetchImpl: async (_url, init) => {
        calls.push({
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        })
        return new Response(JSON.stringify({ choices: [{ message: { content: "  OK  " } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    })

    expect(res.exitCode).toBe(0)
    const body = calls[0]?.body as { messages?: Array<{ role?: string; content?: string }> } | undefined
    const system = body?.messages?.find((m) => m.role === "system")?.content ?? ""
    expect(system).toContain("agent `repo-brain`")
    expect(system).toContain("You are the Repo Brain. Stay inside the selected repository.")
  })

  it("does not advertise cross-repo tools just because reposRoot is present", async () => {
    const sessionFile = path.join(tmp, "s.jsonl")
    appendTurn(sessionFile, { role: "user", content: "which repos can you access?", timestamp: "t1" })
    const sink = new MemSink()
    const calls: Array<{ body: Record<string, unknown> }> = []
    const res = await runChatTurn({
      sessionId: "s1",
      sessionFile,
      store: testStore(sessionFile),
      cwd: tmp,
      model: { provider: "custom", model: "MiniMax-M3", protocol: "openai", spec: "minimax/MiniMax-M3" },
      litellmUrl: "http://localhost:4000",
      sink,
      reposRoot: path.join(tmp, "repos"),
      fetchImpl: async (_url, init) => {
        calls.push({
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        })
        return new Response(JSON.stringify({ choices: [{ message: { content: "  OK  " } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    })

    expect(res.exitCode).toBe(0)
    const body = calls[0]?.body as { messages?: Array<{ role?: string; content?: string }> } | undefined
    const system = body?.messages?.find((m) => m.role === "system")?.content ?? ""
    expect(system).not.toContain("Working across repositories")
    expect(system).not.toContain("fetch_repo")
  })

  it("advertises cross-repo tools only when explicitly enabled", async () => {
    const sessionFile = path.join(tmp, "s.jsonl")
    appendTurn(sessionFile, { role: "user", content: "compare repos", timestamp: "t1" })
    const sink = new MemSink()
    const calls: Array<{ body: Record<string, unknown> }> = []
    const res = await runChatTurn({
      sessionId: "s1",
      sessionFile,
      store: testStore(sessionFile),
      cwd: tmp,
      model: { provider: "custom", model: "MiniMax-M3", protocol: "openai", spec: "minimax/MiniMax-M3" },
      litellmUrl: "http://localhost:4000",
      sink,
      reposRoot: path.join(tmp, "repos"),
      enableFetchRepoTool: true,
      fetchImpl: async (_url, init) => {
        calls.push({
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        })
        return new Response(JSON.stringify({ choices: [{ message: { content: "  OK  " } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    })

    expect(res.exitCode).toBe(0)
    const body = calls[0]?.body as { messages?: Array<{ role?: string; content?: string }> } | undefined
    const system = body?.messages?.find((m) => m.role === "system")?.content ?? ""
    expect(system).toContain("Working across repositories")
    expect(system).toContain("fetch_repo")
  })

  it("emits chat.error and returns 99 when agent throws", async () => {
    const sessionFile = path.join(tmp, "s.jsonl")
    appendTurn(sessionFile, { role: "user", content: "hi", timestamp: "t1" })
    const sink = new MemSink()
    const res = await runChatTurn({
      sessionId: "s1",
      sessionFile,
      store: testStore(sessionFile),
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
      store: testStore(sessionFile),
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
