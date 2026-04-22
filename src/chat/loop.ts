/**
 * Persistent chat session loop.
 *
 * Pulls new user turns from the dashboard (/api/kody/chat/pull), runs one
 * agent turn per user message with full in-memory history, pushes events
 * back via the sink. Idles between pulls; exits on idle timeout, terminal
 * event, or hard runtime cap.
 *
 * Chat is ephemeral — no git reads, no git writes. Session transcripts
 * live only in dashboard memory + this runner's heap for the session's
 * lifetime.
 */

import type { AgentResult } from "../agent.js"
import { runAgent } from "../agent.js"
import type { ProviderModel } from "../config.js"
import type { ChatEvent, EventSink } from "./events.js"
import { makeRunId } from "./events.js"

export const CHAT_SYSTEM_PROMPT = [
  "You are Kody, an AI assistant for the Kody Operations Dashboard. Reply to the user's",
  "latest message using the full conversation below as context. Keep replies focused,",
  "technical when appropriate, and formatted in Markdown. Use the available tools to",
  "read repository code or execute small checks when it helps you answer — otherwise",
  "reply directly. Do not invent file paths, commit SHAs, or command output.",
].join("\n")

export interface ChatTurn {
  role: "user" | "assistant"
  content: string
  timestamp: string
}

interface PullResponse {
  turns: ChatTurn[]
  nextSince: number
}

export type PullFn = (since: number, timeoutMs: number) => Promise<PullResponse>

export interface ChatLoopOptions {
  sessionId: string
  cwd: string
  model: ProviderModel
  litellmUrl: string | null
  sink: EventSink
  pull: PullFn
  verbose?: boolean
  quiet?: boolean
  /** Exit if no user turn arrives for this long (ms). */
  idleTimeoutMs?: number
  /** Hard cap on loop runtime regardless of activity (ms). */
  hardTimeoutMs?: number
  /** Override for the per-pull long-poll timeout (ms). */
  pullTimeoutMs?: number
  /** Override for the system prompt (tests). */
  systemPrompt?: string
  /** Seam for tests — defaults to real runAgent. */
  invokeAgent?: (prompt: string) => Promise<AgentResult>
  /** Clock seam for tests. */
  now?: () => number
}

export interface ChatLoopResult {
  exitCode: number
  turnsProcessed: number
  reason?: string
}

const DEFAULT_IDLE_TIMEOUT_MS = 3 * 60 * 1000
const DEFAULT_HARD_TIMEOUT_MS = 5 * 60 * 60 * 1000 // 5h, under GH Actions 6h job cap
const DEFAULT_PULL_TIMEOUT_MS = 25_000

export async function runChatSession(opts: ChatLoopOptions): Promise<ChatLoopResult> {
  const now = opts.now ?? (() => Date.now())
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const hardTimeoutMs = opts.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS
  const pullTimeoutMs = opts.pullTimeoutMs ?? DEFAULT_PULL_TIMEOUT_MS
  const systemPrompt = opts.systemPrompt ?? CHAT_SYSTEM_PROMPT

  const invoke =
    opts.invokeAgent ??
    ((p: string) =>
      runAgent({
        prompt: p,
        model: opts.model,
        cwd: opts.cwd,
        litellmUrl: opts.litellmUrl,
        verbose: opts.verbose,
        quiet: opts.quiet,
      }))

  const history: ChatTurn[] = []
  let since = 0
  let lastActivityAt = now()
  const startedAt = now()
  let turnsProcessed = 0

  while (true) {
    if (now() - startedAt > hardTimeoutMs) {
      await emit(opts.sink, "chat.done", opts.sessionId, "done", {
        sessionId: opts.sessionId,
        reason: "hard-timeout",
      })
      return { exitCode: 0, turnsProcessed, reason: "hard-timeout" }
    }

    let response: PullResponse
    try {
      response = await opts.pull(since, pullTimeoutMs)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await emit(opts.sink, "chat.error", opts.sessionId, "error", { error: `pull failed: ${msg}` })
      return { exitCode: 99, turnsProcessed, reason: `pull failed: ${msg}` }
    }

    if (response.turns.length === 0) {
      if (now() - lastActivityAt > idleTimeoutMs) {
        await emit(opts.sink, "chat.done", opts.sessionId, "done", {
          sessionId: opts.sessionId,
          reason: "idle-timeout",
        })
        return { exitCode: 0, turnsProcessed, reason: "idle-timeout" }
      }
      continue
    }

    // Accept new turns; only "user" role turns are meaningful (assistant
    // turns are emitted by us below, never pulled).
    const newUserTurns = response.turns.filter((t) => t.role === "user")
    for (const t of newUserTurns) history.push(t)
    since = response.nextSince

    if (newUserTurns.length === 0) continue
    lastActivityAt = now()

    // Run one agent turn using the full history.
    const prompt = buildPrompt(history, systemPrompt)
    let result: AgentResult
    try {
      result = await invoke(prompt)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await emit(opts.sink, "chat.error", opts.sessionId, "error", { error: msg })
      return { exitCode: 99, turnsProcessed, reason: msg }
    }

    if (result.outcome !== "completed") {
      const error = result.error ?? "agent did not complete"
      await emit(opts.sink, "chat.error", opts.sessionId, "error", { error })
      return { exitCode: 99, turnsProcessed, reason: error }
    }

    const reply = result.finalText.trim()
    const replyTimestamp = new Date().toISOString()
    history.push({ role: "assistant", content: reply, timestamp: replyTimestamp })
    turnsProcessed++
    lastActivityAt = now()

    await emit(opts.sink, "chat.message", opts.sessionId, `message-${turnsProcessed}`, {
      sessionId: opts.sessionId,
      role: "assistant",
      content: reply,
      timestamp: replyTimestamp,
    })
  }
}

export function buildPrompt(turns: ChatTurn[], systemPrompt: string): string {
  const header = `System: ${systemPrompt}`
  const body = turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`).join("\n\n")
  return `${header}\n\n${body}\n\nAssistant:`
}

async function emit(
  sink: EventSink,
  type: ChatEvent["event"],
  sessionId: string,
  suffix: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await sink.emit({
    event: type,
    payload,
    runId: makeRunId(sessionId, suffix),
    emittedAt: new Date().toISOString(),
  })
}
