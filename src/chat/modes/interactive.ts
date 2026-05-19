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

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import type { AgentResult } from "../../agent.js"
import type { ProviderModel } from "../../config.js"
import { gh } from "../../issue.js"
import type { EventSink } from "../events.js"
import { eventsFilePath, makeRunId } from "../events.js"
import { waitForNextUserMessage } from "../inbox.js"
import type { ChatTurnResult } from "../loop.js"
import { runChatTurn } from "../loop.js"
import type { SessionMeta } from "../session.js"
import { readSession, sessionFilePath } from "../session.js"

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
  /** Test seam — override poll interval (default 30s). */
  pollIntervalMs?: number
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
    commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false)
    process.stdout.write(`→ kody:chat:interactive: chat.ready committed; entering poll loop\n`)
  }

  // Watermark = next index to look at. Start by replying to anything already
  // in the file (the dashboard typically seeds an initial user turn before
  // dispatch). After replying, we move past it and wait for new appends.
  let watermark = 0
  let turnsCompleted = 0

  while (true) {
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
      })
      if (result.kind === "idle-timeout") {
        await emitExit(opts, "idle-timeout", turnsCompleted)
        // Push the exit event so dashboards relying on the git-fallback
        // path see the lifecycle end (HttpSink delivers it real-time, but
        // a freshly-loading client needs the durable record too).
        if (!opts.skipGit) commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false)
        return { exitCode: 0, reason: "idle-timeout", turnsCompleted }
      }
      if (result.kind === "deadline") {
        await emitExit(opts, "deadline", turnsCompleted)
        if (!opts.skipGit) commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false)
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
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await emit(opts.sink, "chat.error", opts.sessionId, `loop-${turnsCompleted}`, { error: msg })
      await emitExit(opts, "fatal", turnsCompleted)
      if (!opts.skipGit) commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false)
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
      if (!opts.skipGit) commitTurn(opts.cwd, opts.sessionId, opts.verbose ?? false)
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

/**
 * Persist the chat session/event JSONLs to the default branch via the
 * GitHub Contents API (one PUT per file) instead of `git commit` + `push`.
 *
 * Why not git push: every interactive session — default-branch *and*
 * vibe/PR runs — funnels these files onto a single shared branch (main).
 * A push updates the whole branch ref, so N concurrent sessions reject
 * each other with non-fast-forward and grind through a rebase-retry
 * storm. The Contents API commits server-side and only conflicts when
 * the *same file* changed under us (stale blob sha) — distinct sessions
 * write distinct files, so they never contend. As a bonus the PR diff
 * stays clean (the commit lands on the default branch, not the runner's
 * checked-out PR branch) with no worktree detour.
 *
 * The files are append-only and the runner has already polled the
 * dashboard's user-turn appends into its local copy before this fires,
 * so the local file is authoritative — a straight overwrite is correct.
 * The only residual race is the dashboard appending a user turn between
 * our GET and PUT (same file); that surfaces as a 409/422 and is handled
 * by the refetch + line-union retry below.
 */
function commitTurn(cwd: string, sessionId: string, _verbose: boolean): void {
  const sessionRel = path.relative(cwd, sessionFilePath(cwd, sessionId))
  const eventsRel = path.relative(cwd, eventsFilePath(cwd, sessionId))
  const rels = [sessionRel, eventsRel].filter((p) => fs.existsSync(path.join(cwd, p)))
  if (rels.length === 0) return

  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) {
    process.stderr.write(
      `[kody:chat:interactive] GITHUB_REPOSITORY unset; cannot persist session/events via Contents API\n`,
    )
    return
  }
  const branch = defaultBranch(cwd) ?? "main"

  for (const rel of rels) {
    const repoPath = rel.split(path.sep).join("/")
    const localText = fs.readFileSync(path.join(cwd, rel), "utf-8")
    putJsonlViaContents(repository, branch, repoPath, localText, sessionId, cwd)
  }
}

/** Split JSONL text into non-empty lines (trailing newline tolerated). */
function jsonlLines(text: string): string[] {
  return text.split("\n").filter((l) => l.length > 0)
}

interface RemoteBlob {
  sha: string | null
  lines: string[]
}

/** GET the file's current blob sha + decoded lines. 404 ⇒ file is new. */
function getRemoteBlob(repository: string, branch: string, repoPath: string, cwd: string): RemoteBlob {
  try {
    const raw = gh(["api", `/repos/${repository}/contents/${repoPath}?ref=${encodeURIComponent(branch)}`], { cwd })
    const o = JSON.parse(raw) as { type?: string; encoding?: string; content?: string; sha?: string }
    if (o.type === "file" && o.encoding === "base64" && typeof o.content === "string" && typeof o.sha === "string") {
      return { sha: o.sha, lines: jsonlLines(Buffer.from(o.content, "base64").toString("utf-8")) }
    }
    return { sha: null, lines: [] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/i.test(msg) || /Not Found/i.test(msg)) return { sha: null, lines: [] }
    throw err
  }
}

/**
 * PUT one append-only JSONL file via the Contents API, retrying on a
 * same-file sha conflict (409/422). On retry the local lines are unioned
 * with any remote-only lines so a concurrent dashboard append is never
 * clobbered (append-only ⇒ union is safe; the resulting order matches
 * what a git-rebase replay would have produced).
 */
function putJsonlViaContents(
  repository: string,
  branch: string,
  repoPath: string,
  localText: string,
  sessionId: string,
  cwd: string,
): void {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const remote = getRemoteBlob(repository, branch, repoPath, cwd)

    let body = localText
    if (attempt > 1 && remote.lines.length > 0) {
      const localLines = jsonlLines(localText)
      const localSet = new Set(localLines)
      const extra = remote.lines.filter((l) => !localSet.has(l))
      if (extra.length > 0) body = [...localLines, ...extra].join("\n") + "\n"
    }

    const payload: Record<string, unknown> = {
      message: `chat: interactive turn for ${sessionId}`,
      content: Buffer.from(body, "utf-8").toString("base64"),
      branch,
    }
    if (remote.sha) payload.sha = remote.sha

    try {
      gh(["api", "--method", "PUT", `/repos/${repository}/contents/${repoPath}`, "--input", "-"], {
        cwd,
        input: JSON.stringify(payload),
      })
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isConflict = /HTTP 409/i.test(msg) || /HTTP 422/i.test(msg) || /does not match|but expected/i.test(msg)
      if (!isConflict || attempt === 3) {
        process.stderr.write(`[kody:chat:interactive] Contents PUT failed (${repoPath}, attempt ${attempt}): ${msg}\n`)
        return
      }
      process.stderr.write(
        `[kody:chat:interactive] Contents PUT conflict (${repoPath}, attempt ${attempt}); refetch+union+retry\n`,
      )
    }
  }
}

/**
 * Returns the repo's default branch name (the branch HEAD points at on
 * the remote — typically `main`). Falls back to `null` if it can't be
 * determined; callers should default to `"main"`.
 */
function defaultBranch(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const symbolic = out.toString("utf-8").trim()
    // Output shape: `origin/main` → strip the remote prefix.
    if (symbolic.startsWith("origin/")) return symbolic.slice("origin/".length)
    return symbolic || null
  } catch {
    return null
  }
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
