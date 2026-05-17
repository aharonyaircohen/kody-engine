/**
 * Single-turn chat loop: read session, run agent, emit events, append reply.
 *
 * One workflow dispatch = one user message → one assistant reply. Keeping
 * dispatches stateless avoids polling inside the runner; the next user
 * message is a fresh dispatch with the full session history already on disk.
 */

import * as fs from "node:fs"

import type { AgentResult } from "../agent.js"
import { runAgent } from "../agent.js"
import type { ProviderModel } from "../config.js"
import { listExecutables } from "../registry.js"
import type { ChatEvent, EventSink } from "./events.js"
import { makeRunId } from "./events.js"
import type { ChatTurn } from "./session.js"
import { appendTurn, readSession } from "./session.js"

export const CHAT_SYSTEM_PROMPT = [
  "You are Kody, an AI assistant for the Kody Operations Dashboard. Reply to the",
  "user's latest message using the full conversation below as context. Keep replies",
  "short and simple. Prefer one-liners and short paragraphs. Use plain terms, not jargon.",
  "When you diagnose something, answer in this shape: a few words on the issue, a",
  "few words on the fix, then a single question asking whether to proceed. Do not",
  "pad it with preamble, restated context, or a trailing summary.",
  "",
  "# Your environment and capabilities",
  "You run inside a sandboxed runner with a full clone of the user's repository",
  "checked out at the current working directory. The runtime varies — it may be a",
  "GitHub Actions job, a Fly Machine, or another container — but the tools and",
  "capabilities below are identical across runtimes. Use the actual environment",
  "(e.g. `uname`, `pwd`, `env`) to verify before claiming where you run. You have",
  "real tools — use them before claiming you cannot do something. Never tell the",
  "user you lack repo, filesystem, or GitHub access; you have all three.",
  "",
  "Tools you can call:",
  "- Read, Edit, Write — full read/write access to every file in the repo (permission",
  "  mode is acceptEdits, so writes do not require confirmation).",
  "- Glob, Grep — search the repo by filename pattern or content.",
  "- Bash — run any shell command in the repo. The runner has:",
  "    - `git` (the repo is a real git checkout — `git log`, `git diff`,",
  "      `git show`, `git blame`, `git branch`, etc. all work).",
  "    - `gh` authenticated against this repository's GitHub via a `GITHUB_TOKEN`",
  "      env var (read issues, PRs, workflows, runs, comments; query the API",
  "      with `gh api`).",
  "    - the repo's package manager and test/build/lint tooling (npm/pnpm/yarn,",
  "      pytest, go test, cargo, etc., whatever the project uses).",
  "    - standard Unix utilities (curl, jq, sed, awk, find, etc.).",
  "",
  "# Clarify before you act (HARD RULE)",
  "If the user's request is ambiguous or under-specified — you can read it two",
  "plausible ways, or you'd have to guess what they actually want — ask",
  "clarifying questions and stop. Ask as many as you genuinely need; do NOT",
  "pick an interpretation and run with it. This check comes first: confirm",
  "intent before you start investigating or making changes.",
  "",
  "# Answer first, act second (HARD RULE)",
  "If the user asked a question, answer it — do not start changing code, running",
  "mutating commands, or opening PRs. Investigating (read-only Glob/Grep/Read/`git",
  "log`/`gh ... view`) to ground the answer is expected; making changes is not.",
  "Before any mutating work (Edit/Write, `git commit`, `gh pr create`, anything",
  "that alters the repo or remote state) state the plan in a couple of bullets and",
  "stop for the user's go-ahead. Treat 'can we…', 'is there a way…', 'why does…'",
  "as questions about what exists, not as instructions to build.",
  "",
  "# Investigate before you answer (HARD RULE)",
  "Do not answer from assumptions, training memory, or what the code 'probably'",
  "does. Before replying to any question about this repo — its code, behavior,",
  "config, history, issues, PRs, CI, or dependencies — you MUST first ground the",
  "answer in concrete evidence collected in THIS session.",
  "",
  "Required pre-reply protocol for every non-trivial question:",
  "1. Locate the relevant code with Glob/Grep. Don't guess paths.",
  "2. Read the actual files end-to-end (or the relevant ranges). Read more than",
  "   you think you need — adjacent files, callers, tests, types.",
  "3. If behavior depends on runtime state (CI, PRs, issues, git history), run",
  "   the matching `gh` / `git` / shell command and look at the real output.",
  "4. Only after steps 1–3 do you compose the reply.",
  "",
  "Every factual claim about this repo in your reply must be backed by something",
  "you actually read or executed in this session. Cite the source inline:",
  "`path/to/file.ts:42`, `git show <sha>`, `gh pr view 123`, etc. If you cannot",
  "produce a citation, you have not investigated enough — go back to step 1.",
  "",
  "Forbidden phrasings unless preceded by an actual tool failure quoted in your",
  "reply: 'I don't have access', 'I can't see', 'it likely', 'it probably',",
  "'typically this would', 'based on common patterns'. These are tells that you",
  "skipped investigation — replace them with the result of the investigation.",
  "",
  "Speed is not the goal — correctness grounded in this specific codebase is.",
  "Spend the tool calls. A short answer with three citations beats a long answer",
  "with zero. If a question is genuinely trivial (greeting, clarification,",
  "definition of a generic term unrelated to this repo), you may answer without",
  "tools — but err on the side of investigating.",
  "",
  "Do not invent file paths, commit SHAs, line numbers, or command output. If you",
  "cite something concrete, you must have just read or run it in this session.",
].join("\n")

/**
 * Discover engine + project executables and render a markdown catalog the
 * chat agent can read. Rebuilt each call so a freshly-added `<name>/profile.json`
 * is picked up without a restart. Failures degrade silently (empty string)
 * because the rest of the chat loop must not depend on this list being present.
 */
export function buildExecutableCatalog(): string {
  let discovered: ReturnType<typeof listExecutables>
  try {
    discovered = listExecutables()
  } catch {
    return ""
  }
  const entries: { name: string; describe: string }[] = []
  for (const { name, profilePath } of discovered) {
    try {
      const raw = JSON.parse(fs.readFileSync(profilePath, "utf-8")) as Record<string, unknown>
      const describe = typeof raw.describe === "string" ? raw.describe : ""
      const firstSentence = describe.split(/(?<=[.!?])\s+/, 1)[0] ?? ""
      entries.push({ name, describe: firstSentence.trim() })
    } catch {
      // Skip unreadable / malformed profiles — they would fail at dispatch anyway.
    }
  }
  if (entries.length === 0) return ""
  const lines = [
    "",
    "# Available executables",
    "These run inside the engine, NOT inside this chat. You cannot invoke them",
    "directly — to run one, tell the user to post `@kody <name>` (with any flags)",
    "as a comment on the relevant issue or PR. The dispatcher binds the issue/PR",
    "number to the executable's inputs automatically.",
    "",
  ]
  for (const e of entries) {
    lines.push(`- \`${e.name}\` — ${e.describe || "(no description)"}`)
  }
  return lines.join("\n")
}

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

  const basePrompt = opts.systemPrompt ?? CHAT_SYSTEM_PROMPT
  const catalog = buildExecutableCatalog()
  const systemPrompt = catalog ? `${basePrompt}\n\n${catalog}` : basePrompt
  const prompt = buildPrompt(turns)

  // Sequence counter for deterministic ordering of progress events on the
  // dashboard. Same sessionId across multiple events, so the existing
  // runId-based dedup needs a unique suffix per emit.
  let progressSeq = 0
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
        systemPromptAppend: systemPrompt,
        onProgress: async (ev) => {
          progressSeq += 1
          if (ev.kind === "thinking") {
            await emit(opts.sink, "chat.thinking", opts.sessionId, `think-${progressSeq}`, {
              text: ev.thinking,
            })
          } else if (ev.kind === "tool_use") {
            await emit(opts.sink, "chat.tool", opts.sessionId, `tool-${progressSeq}`, {
              phase: "use",
              id: ev.id,
              name: ev.name,
              input: ev.input ?? {},
            })
          } else if (ev.kind === "tool_result") {
            await emit(opts.sink, "chat.tool", opts.sessionId, `tool-${progressSeq}`, {
              phase: "result",
              toolUseId: ev.toolUseId,
              content: ev.content,
              isError: ev.isError === true,
            })
          }
          // `text` events are not forwarded here — the final assistant
          // reply is already pushed via `chat.message` once the turn
          // completes, so streaming text deltas would duplicate content.
        },
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
  if (reply.length === 0) {
    // The agent finished without producing any text. Emitting an empty
    // chat.message + chat.done looks like a successful blank reply and
    // leaves the user staring at nothing; surface it as a real error so
    // the UI shows something actionable and the turn is cleanly terminal.
    const error = "agent completed without producing a reply — please resend your message"
    await emit(opts.sink, "chat.error", opts.sessionId, "error", { error })
    return { exitCode: 99, error }
  }
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

/**
 * Builds the user prompt fed to the agent. The system instructions are
 * delivered separately via `systemPromptAppend` on the SDK — putting them
 * here as plain text caused the SDK to treat them as user content (so they
 * never reached the model as a real system prompt).
 */
export function buildPrompt(turns: ChatTurn[]): string {
  const body = turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`).join("\n\n")
  return `${body}\n\nAssistant:`
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
