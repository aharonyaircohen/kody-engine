/**
 * End-to-end simulation of interactive chat mode.
 *
 * Reproduces the manual GHA runner test in-process: hand-crafted session file
 * with a meta line, runs runInteractiveMode against it, concurrently appends
 * a second user message mid-loop, and asserts the runner picks it up, replies,
 * and exits cleanly on idle.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AgentResult } from "../../src/agent.js"
import type { ChatEvent, EventSink } from "../../src/chat/events.js"
import { runInteractiveMode } from "../../src/chat/modes/interactive.js"
import { appendTurn, readMeta, readSession, sessionFilePath } from "../../src/chat/session.js"
import type { SessionStore } from "../../src/chat/session-store.js"

class MemSink implements EventSink {
  events: ChatEvent[] = []
  async emit(e: ChatEvent): Promise<void> {
    this.events.push(e)
    process.stdout.write(`  [event] ${e.event} ${JSON.stringify(e.payload).slice(0, 80)}\n`)
  }
}

const MODEL = { provider: "anthropic", model: "claude-haiku-4-5-20251001" }

function testStore(sessionFile: string): SessionStore {
  return {
    backend: "convex",
    readMode: async () => "interactive",
    readActiveAgent: async () => ({ slug: "kody", title: "Kody" }),
    readTurns: async () => readSession(sessionFile),
    appendTurn: async (turn) => appendTurn(sessionFile, turn),
  }
}

describe("chat/modes/interactive — end-to-end simulation", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-interactive-sim-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("readMeta detects interactive mode", () => {
    const sessionId = "sim1"
    const file = sessionFilePath(tmp, sessionId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: "meta", mode: "interactive", idleExitMs: 1000, hardCapMs: 5000 })}\n` +
        `${JSON.stringify({ role: "user", content: "first message", timestamp: "2026-05-06T12:00:00Z" })}\n`,
    )
    const meta = readMeta(file)
    expect(meta?.mode).toBe("interactive")
    expect(meta?.idleExitMs).toBe(1000)
  })

  it("readMeta returns null for legacy session (no meta line)", () => {
    const sessionId = "sim-legacy"
    const file = sessionFilePath(tmp, sessionId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ role: "user", content: "hi", timestamp: "t" })}\n`)
    expect(readMeta(file)).toBeNull()
  })

  it("processes initial message, picks up mid-flight append, then idles out", async () => {
    const sessionId = "sim-e2e"
    const sessionFile = sessionFilePath(tmp, sessionId)
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true })

    // Seed: meta line + first user turn (the "dispatch" payload).
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: "meta", mode: "interactive", idleExitMs: 800, hardCapMs: 6000 })}\n` +
        `${JSON.stringify({ role: "user", content: "hello kody", timestamp: "t1" })}\n`,
    )

    const sink = new MemSink()
    let agentCalls = 0
    const invokeAgent = async (prompt: string): Promise<AgentResult> => {
      agentCalls += 1
      const lastUser = prompt.match(/User: ([^\n]+)\n\nAssistant:$/)?.[1] ?? "?"
      process.stdout.write(`  [agent] turn ${agentCalls}, last user: "${lastUser}"\n`)
      return {
        outcome: "completed",
        finalText: `reply-to-"${lastUser}"`,
      } as AgentResult
    }

    // Schedule a dashboard-style mid-flight append after the runner has had
    // time to process the seed message. This emulates the dashboard pushing
    // a new user turn while the runner sits in its poll loop.
    const midFlightAppend = setTimeout(() => {
      process.stdout.write(`  [dashboard] appending second user message\n`)
      appendTurn(sessionFile, {
        role: "user",
        content: "follow-up question",
        timestamp: "t2",
      })
    }, 250)

    const result = await runInteractiveMode({
      sessionId,
      cwd: tmp,
      model: MODEL,
      litellmUrl: null,
      sink,
      meta: readMeta(sessionFile)!,
      invokeAgent,
      skipGit: true,
      pollIntervalMs: 100,
      store: testStore(sessionFile),
    })

    clearTimeout(midFlightAppend)

    // Loop should have processed both user turns and exited on idle.
    expect(result.reason).toBe("idle-timeout")
    expect(result.exitCode).toBe(0)
    expect(result.turnsCompleted).toBe(2)
    expect(agentCalls).toBe(2)

    // Session file should now contain meta + 2 user + 2 assistant.
    const turns = readSession(sessionFile)
    expect(turns.length).toBe(4)
    expect(turns[0]).toMatchObject({ role: "user", content: "hello kody" })
    expect(turns[1]).toMatchObject({ role: "assistant", content: 'reply-to-"hello kody"' })
    expect(turns[2]).toMatchObject({ role: "user", content: "follow-up question" })
    expect(turns[3]).toMatchObject({ role: "assistant", content: 'reply-to-"follow-up question"' })

    // Lifecycle events: ready first, exit last, with messages in between.
    const types = sink.events.map((e) => e.event)
    expect(types[0]).toBe("chat.ready")
    expect(types[types.length - 1]).toBe("chat.exit")
    expect(types.filter((t) => t === "chat.message").length).toBe(2)

    const exitEvent = sink.events[sink.events.length - 1]!
    expect(exitEvent.payload.reason).toBe("idle-timeout")
    expect(exitEvent.payload.turnsCompleted).toBe(2)
  }, 10_000)

  it("multi-turn conversation: agent sees full history in every prompt", async () => {
    const sessionId = "sim-history"
    const sessionFile = sessionFilePath(tmp, sessionId)
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true })

    // Seed with meta + the first user question. Three more questions get
    // appended mid-flight (simulating the dashboard sending follow-ups).
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: "meta", mode: "interactive", idleExitMs: 800, hardCapMs: 8000 })}\n` +
        `${JSON.stringify({ role: "user", content: "my favorite number is 42", timestamp: "t1" })}\n`,
    )

    const userMessages = [
      "my favorite number is 42", // already seeded
      "what color is the sky?",
      "remind me of my favorite number",
      "name two things we've discussed",
    ]

    // Capture every prompt the agent receives so we can assert that each
    // turn N sees all N prior user messages plus all N-1 assistant replies.
    const promptsReceived: string[] = []
    const sink = new MemSink()

    const invokeAgent = async (prompt: string): Promise<AgentResult> => {
      promptsReceived.push(prompt)
      const turnIdx = promptsReceived.length

      // Compose a deterministic reply that references the conversation so we
      // can verify context awareness without a real model.
      const userCount = (prompt.match(/^User:/gm) ?? []).length
      const assistantCount = (prompt.match(/^Assistant: /gm) ?? []).length
      const lastUser = prompt.match(/User: ([^\n]+)\n\nAssistant:$/)?.[1] ?? "?"

      let reply: string
      if (turnIdx === 1) {
        reply = "noted — your favorite number is 42"
      } else if (turnIdx === 2) {
        reply = "the sky is blue"
      } else if (turnIdx === 3) {
        // History test: this reply should reference 42 from turn 1.
        const numberMatch = prompt.match(/favorite number is (\d+)/)
        reply = numberMatch ? `you said ${numberMatch[1]}` : "I don't remember"
      } else {
        // History test: this reply should reference both prior topics.
        const sawNumber = /favorite number/.test(prompt)
        const sawSky = /sky/.test(prompt)
        reply = `we discussed: ${sawNumber ? "your favorite number" : "?"} and ${sawSky ? "the sky color" : "?"}`
      }

      process.stdout.write(
        `  [agent] turn ${turnIdx}: saw ${userCount} user + ${assistantCount} assistant turns | last user="${lastUser}" → "${reply}"\n`,
      )
      return { outcome: "completed", finalText: reply } as AgentResult
    }

    // Schedule the three follow-up appends, staggered so the runner has time
    // to process the previous turn before the next message arrives.
    const timers: NodeJS.Timeout[] = []
    for (let i = 1; i < userMessages.length; i++) {
      timers.push(
        setTimeout(
          () => {
            process.stdout.write(`  [dashboard] appending: "${userMessages[i]}"\n`)
            appendTurn(sessionFile, {
              role: "user",
              content: userMessages[i]!,
              timestamp: `t${i + 1}`,
            })
          },
          200 + i * 200,
        ),
      )
    }

    const result = await runInteractiveMode({
      sessionId,
      cwd: tmp,
      model: MODEL,
      litellmUrl: null,
      sink,
      meta: readMeta(sessionFile)!,
      invokeAgent,
      skipGit: true,
      pollIntervalMs: 80,
      store: testStore(sessionFile),
    })

    for (const t of timers) clearTimeout(t)

    expect(result.exitCode).toBe(0)
    expect(result.turnsCompleted).toBe(4)
    expect(promptsReceived.length).toBe(4)

    // Each turn's prompt must contain ALL prior user messages + assistant replies.
    for (let i = 0; i < 4; i++) {
      const p = promptsReceived[i]!
      const userCountInPrompt = (p.match(/^User:/gm) ?? []).length
      const assistantCountInPrompt = (p.match(/^Assistant: /gm) ?? []).length
      expect(userCountInPrompt).toBe(i + 1)
      expect(assistantCountInPrompt).toBe(i)
      // Every earlier user message must be present in the prompt.
      for (let j = 0; j <= i; j++) {
        expect(p).toContain(userMessages[j]!)
      }
    }

    // Context-awareness assertions: the agent's actual replies depend on
    // it having seen earlier turns — these would fail if history wasn't
    // being threaded through.
    const turns = readSession(sessionFile)
    expect(turns.length).toBe(8) // 4 user + 4 assistant
    expect(turns[5]?.content).toBe("you said 42") // turn 3 references turn 1's number
    expect(turns[7]?.content).toBe("we discussed: your favorite number and the sky color") // turn 4 references both

    // Lifecycle: ready first, exit last, four chat.message events between.
    const types = sink.events.map((e) => e.event)
    expect(types[0]).toBe("chat.ready")
    expect(types[types.length - 1]).toBe("chat.exit")
    expect(types.filter((t) => t === "chat.message").length).toBe(4)
  }, 15_000)

  it("exits on hard cap when no idle window is reached", async () => {
    const sessionId = "sim-cap"
    const sessionFile = sessionFilePath(tmp, sessionId)
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: "meta", mode: "interactive", idleExitMs: 10_000, hardCapMs: 400 })}\n` +
        `${JSON.stringify({ role: "user", content: "ping", timestamp: "t1" })}\n`,
    )

    const sink = new MemSink()
    const result = await runInteractiveMode({
      sessionId,
      cwd: tmp,
      model: MODEL,
      litellmUrl: null,
      sink,
      meta: readMeta(sessionFile)!,
      invokeAgent: async () =>
        ({
          outcome: "completed",
          finalText: "pong",
        }) as AgentResult,
      skipGit: true,
      pollIntervalMs: 80,
      store: testStore(sessionFile),
    })

    expect(result.reason).toBe("deadline")
    expect(sink.events[sink.events.length - 1]?.payload.reason).toBe("deadline")
  }, 10_000)
})
