/**
 * Single-turn chat loop: read session, run agent, emit events, append reply.
 *
 * One workflow dispatch = one user message → one assistant reply. Keeping
 * dispatches stateless avoids polling inside the runner; the next user
 * message is a fresh dispatch with the full session history already on disk.
 */

import type { AgentResult } from "../agent.js"
import { runAgent } from "../agent.js"
import type { ProviderModel } from "../config.js"
import type { ChatEvent, EventSink } from "./events.js"
import { makeRunId } from "./events.js"
import type { ChatTurn } from "./session.js"
import { appendTurn, readSession } from "./session.js"

export const CHAT_SYSTEM_PROMPT = [
  "You are Kody, an AI assistant for the Kody Operations Dashboard. Reply to the",
  "user's latest message using the full conversation below as context. Keep replies",
  "focused, technical when appropriate, and formatted in Markdown.",
  "",
  "# Your environment and capabilities",
  "You run inside a GitHub Actions job with a full clone of the user's repository",
  "checked out at the current working directory. You have real tools — use them",
  "before claiming you cannot do something. Never tell the user you lack repo,",
  "filesystem, or GitHub access; you have all three.",
  "",
  "Tools you can call:",
  "- Read, Edit, Write — full read/write access to every file in the repo (permission",
  "  mode is acceptEdits, so writes do not require confirmation).",
  "- Glob, Grep — search the repo by filename pattern or content.",
  "- Bash — run any shell command in the repo. The runner has:",
  "    - `git` (the repo is a real git checkout — `git log`, `git diff`,",
  "      `git show`, `git blame`, `git branch`, etc. all work).",
  "    - `gh` authenticated against this repository's GitHub via the Actions",
  "      `GITHUB_TOKEN` (read issues, PRs, workflows, runs, comments; query the API",
  "      with `gh api`).",
  "    - the repo's package manager and test/build/lint tooling (npm/pnpm/yarn,",
  "      pytest, go test, cargo, etc., whatever the project uses).",
  "    - standard Unix utilities (curl, jq, sed, awk, find, etc.).",
  "",
  "# How to answer",
  "If the user asks about repo content, code, history, issues, PRs, CI status, or",
  "anything else knowable from the checkout or GitHub API, INVESTIGATE FIRST with",
  "the tools above and answer from what you find. Do not say 'I don't have access'",
  "— if you have not yet tried, try. Only fall back to a limitation statement after",
  "a tool actually fails, and in that case quote the failing command and its error.",
  "",
  "Do not invent file paths, commit SHAs, line numbers, or command output. If you",
  "cite something concrete, you must have just read or run it in this session.",
].join("\n")

export interface ChatTurnOptions {
  sessionId: string
  sessionFile: string
  cwd: string
  model: ProviderModel
  litellmUrl: string | null
  sink: EventSink
  verbose?: boolean
  quiet?: boolean
  /** Override for the system prompt (tests). */
  systemPrompt?: string
  /** Seam for tests — defaults to real runAgent. */
  invokeAgent?: (prompt: string) => Promise<AgentResult>
}

export interface ChatTurnResult {
  exitCode: number
  reply?: string
  error?: string
}

export async function runChatTurn(opts: ChatTurnOptions): Promise<ChatTurnResult> {
  const turns = readSession(opts.sessionFile)
  if (turns.length === 0) {
    const error = "session file is empty — nothing to reply to"
    await emit(opts.sink, "chat.error", opts.sessionId, "error", { error })
    return { exitCode: 64, error }
  }
  const lastTurn = turns[turns.length - 1]!
  if (lastTurn.role !== "user") {
    const error = "last turn is not a user message — assistant already replied"
    await emit(opts.sink, "chat.error", opts.sessionId, "error", { error })
    return { exitCode: 64, error }
  }

  const prompt = buildPrompt(turns, opts.systemPrompt ?? CHAT_SYSTEM_PROMPT)
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

  let result: AgentResult
  try {
    result = await invoke(prompt)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await emit(opts.sink, "chat.error", opts.sessionId, "error", { error })
    return { exitCode: 99, error }
  }

  if (result.outcome !== "completed") {
    const error = result.error ?? "agent did not complete"
    await emit(opts.sink, "chat.error", opts.sessionId, "error", { error })
    return { exitCode: 99, error }
  }

  const reply = result.finalText.trim()
  const now = new Date().toISOString()

  appendTurn(opts.sessionFile, {
    role: "assistant",
    content: reply,
    timestamp: now,
  })

  await emit(opts.sink, "chat.message", opts.sessionId, "message", {
    sessionId: opts.sessionId,
    role: "assistant",
    content: reply,
    timestamp: now,
  })
  await emit(opts.sink, "chat.done", opts.sessionId, "done", { sessionId: opts.sessionId })

  return { exitCode: 0, reply }
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
