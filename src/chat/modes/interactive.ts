/**
 * Interactive chat mode — long-lived runner that polls the canonical
 * conversation for new user messages and runs a turn for each.
 *
 * Activated when the canonical conversation runtime is `live`.
 *
 * Lifecycle events (consumed by the dashboard):
 *  - `chat.ready` — emitted once at boot. Dashboard unlocks the input.
 *  - `chat.message` / `chat.tool` / etc. — per-turn (same as one-shot).
 *  - `chat.exit`  — emitted on idle timeout, hard cap, or fatal error.
 */

import type { AgentResult } from "../../agent.js"
import type { KodyConfig, ProviderModel, ReasoningEffort } from "../../config.js"
import type { EventSink } from "../events.js"
import { makeRunId } from "../events.js"
import { waitForNextUserMessage } from "../inbox.js"
import type { ChatTurnResult } from "../loop.js"
import { runChatTurn } from "../loop.js"
import type { ChatTurn, SessionMeta } from "../session.js"
import { sessionFilePath } from "../session.js"
import type { SessionStore } from "../session-store.js"
import { createSessionStore } from "../session-store.js"

const DEFAULT_IDLE_EXIT_MS = 5 * 60_000 // 5 minutes
const DEFAULT_HARD_CAP_MS = 30 * 60_000 // 30 minutes (spike cap; raise to 6h after validation)
const DEFAULT_POLL_MS = 3_000

export interface InteractiveModeOptions {
  sessionId: string
  cwd: string
  model: ProviderModel
  litellmUrl: string | null
  sink: EventSink
  meta: SessionMeta
  verbose?: boolean
  quiet?: boolean
  /** Test seam — bypasses real agent invocation. Threaded into runChatTurn. */
  invokeAgent?: (prompt: string) => Promise<AgentResult>
  /** Test seam — skip git pull, commit, push. Useful for in-process simulation. */
  skipGit?: boolean
  /** Consumer identity used to scope backend runtime state. */
  config?: KodyConfig | null
  /** Test seam — override poll interval (default 30s). */
  pollIntervalMs?: number
  /** Transcript store override (tests). Defaults per session-store.ts. */
  store?: SessionStore
  /**
   * Thinking level. Forwarded to every `runChatTurn` call inside the
   * loop so each turn gets the same thinking budget. Unset / `"off"`
   * means no thinking block — cheapest path.
   */
  reasoningEffort?: ReasoningEffort | null
}

export interface InteractiveModeResult {
  exitCode: number
  reason: "idle-timeout" | "deadline" | "fatal" | "ended"
  turnsCompleted: number
}

export async function runInteractiveMode(opts: InteractiveModeOptions): Promise<InteractiveModeResult> {
  const sessionFile = sessionFilePath(opts.cwd, opts.sessionId)
  const store = opts.store ?? createSessionStore({ sessionId: opts.sessionId, sessionFile })
  const idleExitMs = opts.meta.idleExitMs ?? DEFAULT_IDLE_EXIT_MS
  const hardCapMs = opts.meta.hardCapMs ?? DEFAULT_HARD_CAP_MS
  const startedAt = Date.now()
  const deadlineMs = startedAt + hardCapMs

  // GitHub Actions injects these automatically — no setup in kody.yml.
  // The dashboard uses runUrl to deep-link the booting banner straight to
  // this specific run instead of the workflow's run list.
  const runId = process.env.GITHUB_RUN_ID
  const repository = process.env.GITHUB_REPOSITORY
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com"
  const runUrl = runId && repository ? `${serverUrl}/${repository}/actions/runs/${runId}` : undefined

  process.stdout.write(
    `→ kody:chat:interactive: emitting chat.ready (idleExitMs=${idleExitMs}, hardCapMs=${hardCapMs}, runUrl=${runUrl ?? "n/a"})\n`,
  )
  await emit(opts.sink, "chat.ready", opts.sessionId, "ready", {
    sessionId: opts.sessionId,
    startedAt: new Date(startedAt).toISOString(),
    idleExitMs,
    hardCapMs,
    ...(runId ? { runId } : {}),
    ...(runUrl ? { runUrl } : {}),
  })
  // Watermark = next index to look at. Start by replying to anything already
  // in the file (the dashboard typically seeds an initial user turn before
  // dispatch). After replying, we move past it and wait for new appends.
  let watermark = 0
  let turnsCompleted = 0

  while (true) {
    const turns = await store.readTurns()
    const pendingIdx = findNextUserTurn(turns, watermark)

    if (pendingIdx === -1) {
      const result = await waitForNextUserMessage({
        sessionFile,
        cwd: opts.cwd,
        watermark,
        idleTimeoutMs: idleExitMs,
        deadlineMs,
        pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_MS,
        skipPull: opts.skipGit,
        ...(store.backend === "convex" ? { readTurns: () => store.readTurns() } : {}),
      })
      if (result.kind === "idle-timeout") {
        await emitExit(opts, "idle-timeout", turnsCompleted)
        return { exitCode: 0, reason: "idle-timeout", turnsCompleted }
      }
      if (result.kind === "deadline") {
        await emitExit(opts, "deadline", turnsCompleted)
        return { exitCode: 0, reason: "deadline", turnsCompleted }
      }
      // New message arrived — fall through and process it via runChatTurn,
      // which itself reads the session fresh.
    }

    let turnResult: ChatTurnResult
    try {
      turnResult = await runChatTurn({
        sessionId: opts.sessionId,
        sessionFile,
        cwd: opts.cwd,
        model: opts.model,
        litellmUrl: opts.litellmUrl,
        sink: opts.sink,
        verbose: opts.verbose,
        quiet: opts.quiet,
        invokeAgent: opts.invokeAgent,
        config: opts.config,
        store,
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await emit(opts.sink, "chat.error", opts.sessionId, `loop-${turnsCompleted}`, { error: msg })
      await emitExit(opts, "fatal", turnsCompleted)
      return { exitCode: 99, reason: "fatal", turnsCompleted }
    }

    if (turnResult.exitCode === 64) {
      // "session empty" or "last turn already assistant" — treat as idle, keep polling.
      // This happens normally when the runner re-enters after replying.
    } else if (turnResult.exitCode !== 0) {
      // Non-fatal turn failures are emitted by runChatTurn via the sink. Don't
      // tear down the session — the user can retry.
    } else {
      turnsCompleted += 1
    }

    // Advance watermark past everything we've seen, including the just-appended
    // assistant reply. Re-read because runChatTurn appends.
    watermark = (await store.readTurns()).length
  }
}

function findNextUserTurn(turns: ChatTurn[], fromIdx: number): number {
  for (let i = fromIdx; i < turns.length; i++) {
    if (turns[i]!.role === "user") return i
  }
  // If the trailing turn is `user`, runChatTurn will reply. Otherwise (last is
  // assistant or list empty from index), there's nothing pending.
  if (turns.length > 0 && turns[turns.length - 1]!.role === "user") return turns.length - 1
  return -1
}

async function emitExit(
  opts: InteractiveModeOptions,
  reason: InteractiveModeResult["reason"],
  turnsCompleted: number,
): Promise<void> {
  await emit(opts.sink, "chat.exit", opts.sessionId, "exit", {
    sessionId: opts.sessionId,
    reason,
    turnsCompleted,
    endedAt: new Date().toISOString(),
  })
}

async function emit(
  sink: EventSink,
  type: "chat.ready" | "chat.exit" | "chat.error",
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
