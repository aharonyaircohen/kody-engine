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
import * as os from "node:os"
import * as path from "node:path"
import type { AgentResult } from "../../agent.js"
import type { ProviderModel } from "../../config.js"
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

  process.stdout.write(`→ kody:chat:interactive: emitting chat.ready (idleExitMs=${idleExitMs}, hardCapMs=${hardCapMs}, runUrl=${runUrl ?? "n/a"})\n`)
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
 * Commit + push the chat session/events files. The session/event JSONLs
 * are runner-internal bookkeeping — they belong on the default branch
 * (where the dashboard's poll reads from via the Contents API), NOT on
 * whatever branch the runner happens to be checked out on.
 *
 * For vibe sessions HEAD is the PR branch — committing the JSONLs there
 * pollutes the PR diff with `.kody/sessions/<id>.jsonl` and
 * `.kody/events/<id>.jsonl` rows that reviewers have to scroll past,
 * and the files persist forever in main's history once the PR merges.
 * Route the commit through a temporary worktree on `main` instead so
 * the runner's working tree stays untouched and the PR diff is clean.
 *
 * For default-branch runs HEAD is already main, so we skip the worktree
 * detour and commit + push directly.
 *
 * Both paths use the same retry-on-non-fast-forward push loop: when the
 * dashboard's user-turn append (Contents API) races the runner's
 * chat.message commit, OR when two interactive sessions push to the
 * same branch back-to-back, the second push gets rejected. Without the
 * retry the events file never reaches origin and the dashboard's poll
 * sees nothing forever.
 */
function commitTurn(cwd: string, sessionId: string, verbose: boolean): void {
  const sessionRel = path.relative(cwd, sessionFilePath(cwd, sessionId))
  const eventsRel = path.relative(cwd, eventsFilePath(cwd, sessionId))
  const paths = [sessionRel, eventsRel].filter((p) => fs.existsSync(path.join(cwd, p)))
  if (paths.length === 0) return

  const startBranch = currentBranch(cwd)
  const eventsBranch = defaultBranch(cwd) ?? "main"

  if (startBranch === eventsBranch) {
    // Already on main — commit + push in place.
    commitPathsAndPush(cwd, paths, sessionId, verbose, "HEAD")
    return
  }

  // Spin up a detached worktree on origin/<defaultBranch>, copy the
  // JSONLs into it, then commit + push. The runner's main checkout
  // (sitting on the PR branch) is untouched. We use a temp dir under
  // os.tmpdir() so worktree teardown can't trash anything inside the
  // repo cwd.
  const stdio = verbose ? "inherit" : "pipe"
  const exec = (args: string[]) => execFileSync("git", args, { cwd, stdio })
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-events-"))
  let worktreeAdded = false
  try {
    exec(["fetch", "--quiet", "origin", eventsBranch])
    exec(["worktree", "add", "--detach", "--quiet", worktreeDir, `origin/${eventsBranch}`])
    worktreeAdded = true
    // Mirror the JSONL files from the runner's working tree into the
    // worktree. They're append-only so a straight copy is correct;
    // we don't need to merge with anything already on main (the
    // dashboard's appends will have been pulled in by the runner's
    // session-file polling loop before this commit fires).
    for (const rel of paths) {
      const src = path.join(cwd, rel)
      const dst = path.join(worktreeDir, rel)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
    }
    commitPathsAndPush(worktreeDir, paths, sessionId, verbose, `HEAD:${eventsBranch}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody:chat:interactive] worktree commit failed: ${msg}\n`)
  } finally {
    if (worktreeAdded) {
      try { exec(["worktree", "remove", "--force", "--quiet", worktreeDir]) } catch {
        // Worktree teardown best-effort — the temp dir cleanup below still runs.
      }
    }
    try { fs.rmSync(worktreeDir, { recursive: true, force: true }) } catch {
      // Same — best-effort.
    }
  }
}

/**
 * Stage the named paths, commit, and push to `pushSpec` (e.g. `HEAD` or
 * `HEAD:main`). Retries up to 3× on non-fast-forward rejection by
 * fetching and rebasing on top of the target ref.
 */
function commitPathsAndPush(
  cwd: string,
  paths: string[],
  sessionId: string,
  verbose: boolean,
  pushSpec: string,
): void {
  const stdio = verbose ? "inherit" : "pipe"
  const exec = (args: string[]) => execFileSync("git", args, { cwd, stdio })

  try {
    // `-f` because consumer repos sometimes gitignore .kody/*.
    exec(["add", "-f", ...paths])
    exec(["commit", "--quiet", "-m", `chat: interactive turn for ${sessionId}`])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody:chat:interactive] commit failed: ${msg}\n`)
    return
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      exec(["push", "--quiet", "origin", pushSpec])
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isNonFf = /non-fast-forward|fetch first|rejected/i.test(msg)
      if (!isNonFf || attempt === 3) {
        process.stderr.write(`[kody:chat:interactive] push failed (attempt ${attempt}): ${msg}\n`)
        return
      }
      process.stderr.write(`[kody:chat:interactive] push rejected (attempt ${attempt}); fetch+rebase+retry\n`)
      try {
        exec(["fetch", "--quiet", "origin"])
        // For pushSpec='HEAD:main' the rebase target is origin/main; for
        // pushSpec='HEAD' we still want to rebase on the current
        // upstream, which symbolic-ref returns.
        const upstream = pushSpec.includes(":")
          ? `origin/${pushSpec.split(":")[1]}`
          : (() => {
              const branch = currentBranch(cwd)
              return branch ? `origin/${branch}` : null
            })()
        if (!upstream) {
          process.stderr.write(`[kody:chat:interactive] cannot rebase: no upstream resolved\n`)
          return
        }
        exec(["rebase", "--quiet", upstream])
      } catch (rebaseErr) {
        const rmsg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr)
        process.stderr.write(`[kody:chat:interactive] rebase failed: ${rmsg}\n`)
        return
      }
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
    const out = execFileSync(
      "git",
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { cwd, stdio: ["ignore", "pipe", "ignore"] },
    )
    const symbolic = out.toString("utf-8").trim()
    // Output shape: `origin/main` → strip the remote prefix.
    if (symbolic.startsWith("origin/")) return symbolic.slice("origin/".length)
    return symbolic || null
  } catch {
    return null
  }
}

function currentBranch(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
    return out.toString("utf-8").trim() || null
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
