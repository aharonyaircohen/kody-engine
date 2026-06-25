/**
 * Interactive chat mode — long-lived runner that polls for new user messages
 * via the session JSONL inbox and runs a turn for each.
 *
 * Activated when the session file's first line is a meta line with
 * `mode: "interactive"`. Without that meta line, chat falls back to the
 * existing single-turn (one-shot) flow — no behavior change for legacy
 * sessions.
 *
 * Lifecycle events (consumed by the dashboard):
 *  - `chat.ready` — emitted once at boot. Dashboard unlocks the input.
 *  - `chat.message` / `chat.tool` / etc. — per-turn (same as one-shot).
 *  - `chat.exit`  — emitted on idle timeout, hard cap, or fatal error.
 */

import type { AgentResult } from "../../agent.js"
import type { ProviderModel, ReasoningEffort } from "../../config.js"
import type { StateRepoConfig } from "../../stateRepo.js"
import type { EventSink } from "../events.js"
import { makeRunId } from "../events.js"
import { waitForNextUserMessage } from "../inbox.js"
import type { ChatTurnResult } from "../loop.js"
import { runChatTurn } from "../loop.js"
import type { SessionMeta } from "../session.js"
import { readSession, sessionFilePath } from "../session.js"
import { persistChatFilesToState, syncChatSessionFromState } from "../state-sync.js"

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
  /** Configured external state repo for durable session/event JSONL. */
  stateConfig?: StateRepoConfig | null
  /** Test seam — override poll interval (default 30s). */
  pollIntervalMs?: number
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
  // Push the events file to origin RIGHT NOW so the dashboard's git-poll
  // sees chat.ready without waiting for the first turn. Without this, an
  // interactive session with no seed user message stays invisible until
  // the user sends — defeating the "warm up button → input enables" UX.
  if (!opts.skipGit) {
    process.stdout.write(`→ kody:chat:interactive: committing chat.ready event to git\n`)
    commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false, opts.stateConfig ?? null)
    process.stdout.write(`→ kody:chat:interactive: chat.ready committed; entering poll loop\n`)
  }

  // Watermark = next index to look at. Start by replying to anything already
  // in the file (the dashboard typically seeds an initial user turn before
  // dispatch). After replying, we move past it and wait for new appends.
  let watermark = 0
  let turnsCompleted = 0

  while (true) {
    if (opts.stateConfig && !opts.skipGit) {
      syncChatSessionFromState(opts.stateConfig, opts.cwd, opts.sessionId)
    }
    const turns = readSession(sessionFile)
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
        ...(opts.stateConfig
          ? {
              sync: () => syncChatSessionFromState(opts.stateConfig!, opts.cwd, opts.sessionId),
            }
          : {}),
      })
      if (result.kind === "idle-timeout") {
        await emitExit(opts, "idle-timeout", turnsCompleted)
        // Push the exit event so dashboards relying on the git-fallback
        // path see the lifecycle end (HttpSink delivers it real-time, but
        // a freshly-loading client needs the durable record too).
        if (!opts.skipGit) commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false, opts.stateConfig ?? null)
        return { exitCode: 0, reason: "idle-timeout", turnsCompleted }
      }
      if (result.kind === "deadline") {
        await emitExit(opts, "deadline", turnsCompleted)
        if (!opts.skipGit) commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false, opts.stateConfig ?? null)
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
        stateConfig: opts.stateConfig,
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await emit(opts.sink, "chat.error", opts.sessionId, `loop-${turnsCompleted}`, { error: msg })
      await emitExit(opts, "fatal", turnsCompleted)
      if (!opts.skipGit) commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false, opts.stateConfig ?? null)
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
      if (!opts.skipGit) commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false, opts.stateConfig ?? null)
    }

    // Advance watermark past everything we've seen, including the just-appended
    // assistant reply. Re-read because runChatTurn appends.
    watermark = readSession(sessionFile).length
  }
}

function findNextUserTurn(turns: ReturnType<typeof readSession>, fromIdx: number): number {
  for (let i = fromIdx; i < turns.length; i++) {
    if (turns[i]!.role === "user") return i
  }
  // If the trailing turn is `user`, runChatTurn will reply. Otherwise (last is
  // assistant or list empty from index), there's nothing pending.
  if (turns.length > 0 && turns[turns.length - 1]!.role === "user") return turns.length - 1
  return -1
}

/** Persist chat session/event JSONLs to the configured external state repo. */
function commitTurn(cwd: string, sessionId: string, _verbose: boolean, stateConfig: StateRepoConfig | null): void {
  if (stateConfig) {
    persistChatFilesToState(stateConfig, cwd, sessionId, `chat: interactive turn for ${sessionId}`)
    return
  }

  throw new Error(`kody chat interactive requires state repo config for session ${sessionId}`)
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
