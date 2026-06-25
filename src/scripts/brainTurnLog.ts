/**
 * Turn broker for brain-serve — decouples a chat turn's lifetime from the
 * HTTP request that started it.
 *
 * Why: the dashboard reaches brain-serve through a Vercel function that is
 * hard-killed at ~300s. Before this, the turn ran inside that request, so a
 * turn longer than the Vercel ceiling was lost. Now a turn runs to completion
 * server-side regardless of client connection; every event is tagged with a
 * per-chat monotonic `seq` and appended to a local cache that brain-serve syncs
 * to `brain-events/<chatId>.jsonl` in the configured state repo. A disconnected
 * client reconnects with `?since=<seq>` (GET /chats/:id/stream) and we replay
 * the gap from the log, then live-tail the still-running turn until its
 * terminal event.
 *
 * The state repo is the source of truth for replay; the in-memory registry only
 * accelerates live fan-out. If the process restarts mid-turn the in-memory turn
 * is gone but the synced log survives — a resume then replays what was
 * persisted and, finding no terminal event and no live turn, reports an honest
 * "interrupted" error instead of hanging forever.
 *
 * This mirrors the VPS brain's turn-log.js so both Brain backends honour the
 * same resumable contract the dashboard proxy already speaks.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import posixPath from "node:path/posix"

import { runtimeStatePath } from "../runtimePaths.js"
import type { BrainEvent } from "../servers/brain-serve.js"

export interface TurnRecord {
  seq: number
  turn: number
  ts: number
  event: BrainEvent
}

interface LiveTurn {
  seq: number
  turn: number
  status: "running" | "ended"
  terminal: TurnRecord | null
  subscribers: Set<(rec: TurnRecord | null) => void>
}

/** chatId -> live turn state */
const live = new Map<string, LiveTurn>()

export function brainEventsFilePath(dir: string, chatId: string): string {
  return runtimeStatePath(dir, "brain-events", `${chatId}.jsonl`)
}

export function brainEventsStatePath(chatId: string): string {
  return posixPath.join("brain-events", `${chatId}.jsonl`)
}

function lastPersistedSeq(dir: string, chatId: string): number {
  const p = brainEventsFilePath(dir, chatId)
  if (!fs.existsSync(p)) return 0
  const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean)
  if (lines.length === 0) return 0
  try {
    return (JSON.parse(lines[lines.length - 1]!) as TurnRecord).seq || 0
  } catch {
    return 0
  }
}

export function readSince(dir: string, chatId: string, since: number): TurnRecord[] {
  const p = brainEventsFilePath(dir, chatId)
  if (!fs.existsSync(p)) return []
  const out: TurnRecord[] = []
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    if (!line) continue
    try {
      const rec = JSON.parse(line) as TurnRecord
      if (rec.seq > since) out.push(rec)
    } catch {
      /* skip malformed */
    }
  }
  return out
}

function isTerminal(event: BrainEvent): boolean {
  return event.type === "done" || event.type === "error"
}

/**
 * Begin a new turn. Returns an `emit(event)` sink the runner feeds; every
 * emitted event is sequenced, persisted, and fanned out to subscribers.
 */
export function beginTurn(dir: string, chatId: string): (event: BrainEvent) => void {
  const existing = live.get(chatId)
  const seqFloor = existing ? existing.seq : lastPersistedSeq(dir, chatId)
  const turn = (existing?.turn ?? 0) + 1

  const state: LiveTurn = {
    seq: seqFloor,
    turn,
    status: "running",
    terminal: null,
    subscribers: new Set(),
  }
  live.set(chatId, state)

  const p = brainEventsFilePath(dir, chatId)
  fs.mkdirSync(path.dirname(p), { recursive: true })

  return (event: BrainEvent) => {
    state.seq += 1
    const rec: TurnRecord = { seq: state.seq, turn, ts: Date.now(), event }
    try {
      fs.appendFileSync(p, `${JSON.stringify(rec)}\n`)
    } catch (err) {
      process.stderr.write(
        `[brain-turn-log] append failed for ${chatId}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
    for (const fn of state.subscribers) {
      try {
        fn(rec)
      } catch {
        /* a dead subscriber must not break the turn or other subscribers */
      }
    }
    if (isTerminal(event)) {
      state.status = "ended"
      state.terminal = rec
      const subs = [...state.subscribers]
      state.subscribers.clear()
      for (const fn of subs) {
        try {
          fn(null)
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** Mark a turn ended if the runner threw before emitting a terminal event. */
export function endTurnIfUnterminated(dir: string, chatId: string, errMessage: string): void {
  const state = live.get(chatId)
  if (!state || state.status === "ended") return
  state.seq += 1
  const rec: TurnRecord = {
    seq: state.seq,
    turn: state.turn,
    ts: Date.now(),
    event: { type: "error", error: errMessage || "turn ended unexpectedly", chatId },
  }
  try {
    fs.appendFileSync(brainEventsFilePath(dir, chatId), `${JSON.stringify(rec)}\n`)
  } catch {
    /* best effort */
  }
  state.status = "ended"
  state.terminal = rec
  const subs = [...state.subscribers]
  state.subscribers.clear()
  for (const fn of subs) {
    try {
      fn(rec)
      fn(null)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Attach a client. Replays persisted events with seq > since, then:
 *  - if the turn is live: live-tails until the terminal event, then closes;
 *  - if the turn ended: closes after replay;
 *  - if no live turn and the log has no terminal: emits an interrupted error.
 *
 * Returns an unsubscribe function.
 */
export function subscribe(
  dir: string,
  chatId: string,
  since: number,
  onRecord: (rec: TurnRecord) => void,
  onClose: () => void,
): () => void {
  const backlog = readSince(dir, chatId, since)
  for (const rec of backlog) onRecord(rec)

  const lastReplayed = backlog.length ? backlog[backlog.length - 1]! : null
  if (lastReplayed && isTerminal(lastReplayed.event)) {
    onClose()
    return () => {}
  }

  const state = live.get(chatId)
  if (state && state.status === "running") {
    const fn = (rec: TurnRecord | null) => {
      if (rec === null) {
        state.subscribers.delete(fn)
        onClose()
        return
      }
      if (rec.seq > since) onRecord(rec)
    }
    state.subscribers.add(fn)
    return () => {
      state.subscribers.delete(fn)
    }
  }

  if (state && state.status === "ended" && state.terminal) {
    if (state.terminal.seq > since && !lastReplayed) onRecord(state.terminal)
    onClose()
    return () => {}
  }

  // No live turn and nothing terminal persisted: the process restarted
  // mid-turn (or the chat never had a turn). Fail honestly.
  if (lastReplayed) {
    onRecord({
      seq: lastReplayed.seq + 1,
      turn: lastReplayed.turn,
      ts: Date.now(),
      event: {
        type: "error",
        error: "stream interrupted (server restarted mid-reply) — resend your message",
        chatId,
      },
    })
  }
  onClose()
  return () => {}
}

export function getLastSeq(dir: string, chatId: string): number {
  const state = live.get(chatId)
  if (state) return state.seq
  return lastPersistedSeq(dir, chatId)
}

/** Test-only: drop in-memory state so cases don't bleed across the registry. */
export function __resetTurnLog(): void {
  live.clear()
}
