/**
 * `kody2 chat` — dashboard-driven chat session entry point.
 *
 * Called from the kody2.yml workflow when SESSION_ID is set (the dashboard
 * dispatched a chat message). Intentionally separate from `kody2 ci` —
 * which is an issue/PR automation dispatcher — because chat doesn't need
 * `pnpm install` on the target repo and doesn't key off a GHA event.
 *
 * Flow (one workflow run = one assistant reply):
 *  1. Light preflight (unpack ALL_SECRETS, resolve auth token, configure git).
 *  2. Load config if present, resolve model (CLI flag > config > default).
 *  3. Start LiteLLM proxy for non-anthropic models.
 *  4. Read session file, optionally seed INIT_MESSAGE.
 *  5. Run one chat turn via runAgent; emit events through File+Http sink.
 *  6. Commit + push session and events back so the dashboard sees the reply.
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { FileSink, HttpSink, TeeSink, eventsFilePath, makeRunId } from "./chat/events.js"
import type { EventSink } from "./chat/events.js"
import { runChatTurn } from "./chat/loop.js"
import { sessionFilePath, seedInitialMessage } from "./chat/session.js"
import {
  configureGitIdentity,
  resolveAuthToken,
  unpackAllSecrets,
} from "./kody2-cli.js"
import { loadConfig, parseProviderModel } from "./config.js"
import { startLitellmIfNeeded } from "./litellm.js"

const DEFAULT_MODEL = "claude/claude-haiku-4-5-20251001"

export interface ChatArgs {
  sessionId?: string
  initMessage?: string
  model?: string
  dashboardUrl?: string
  cwd?: string
  verbose?: boolean
  quiet?: boolean
  errors: string[]
}

export const CHAT_HELP = `kody2 chat — dashboard-driven chat session

Usage:
  kody2 chat [--session <id>] [--message <text>] [--model <provider/model>]
             [--dashboard-url <url>] [--cwd <path>] [--verbose|--quiet]

All inputs may also come from env: SESSION_ID, INIT_MESSAGE, MODEL, DASHBOARD_URL.
CLI flags take precedence over env. SESSION_ID is required.

Exit codes:
  0   reply emitted successfully
  64  bad inputs (missing session, empty history)
  99  runtime failure (agent crash, LiteLLM failure)
`

export function parseChatArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ChatArgs {
  const result: ChatArgs = { errors: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--session") result.sessionId = argv[++i]
    else if (arg === "--message") result.initMessage = argv[++i]
    else if (arg === "--model") result.model = argv[++i]
    else if (arg === "--dashboard-url") result.dashboardUrl = argv[++i]
    else if (arg === "--cwd") result.cwd = argv[++i]
    else if (arg === "--verbose") result.verbose = true
    else if (arg === "--quiet") result.quiet = true
    else if (arg === "--help" || arg === "-h") result.errors.push("__HELP__")
    else if (arg?.startsWith("--")) result.errors.push(`unknown arg: ${arg}`)
    else if (arg) result.errors.push(`unexpected positional: ${arg}`)
  }

  // Env fallback — CLI wins.
  result.sessionId = result.sessionId ?? env.SESSION_ID ?? undefined
  result.initMessage = result.initMessage ?? env.INIT_MESSAGE ?? undefined
  result.model = result.model ?? env.MODEL ?? undefined
  result.dashboardUrl = result.dashboardUrl ?? env.DASHBOARD_URL ?? undefined

  // Normalize empty strings (GH Actions passes `""` for unset optional inputs).
  for (const key of ["sessionId", "initMessage", "model", "dashboardUrl"] as const) {
    const v = result[key]
    if (typeof v === "string" && v.trim() === "") result[key] = undefined
  }

  if (!result.sessionId && !result.errors.includes("__HELP__")) {
    result.errors.push("--session <id> (or SESSION_ID env) is required")
  }

  return result
}

function commitChatFiles(cwd: string, sessionId: string, verbose: boolean): void {
  const sessionFile = path.relative(cwd, sessionFilePath(cwd, sessionId))
  const eventsFile = path.relative(cwd, eventsFilePath(cwd, sessionId))
  const paths = [sessionFile, eventsFile].filter((p) => fs.existsSync(path.join(cwd, p)))
  if (paths.length === 0) return
  const opts = { cwd, stdio: verbose ? "inherit" : "pipe" } as const
  try {
    execFileSync("git", ["add", ...paths], opts)
    execFileSync("git", ["commit", "--quiet", "-m", `chat: reply for ${sessionId}`], opts)
    execFileSync("git", ["push", "--quiet", "origin", "HEAD"], opts)
  } catch (err) {
    // Best-effort — if there's nothing staged or push fails, the HttpSink
    // has already delivered the real-time event, so we don't abort the turn.
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody2:chat] commit/push skipped: ${msg}\n`)
  }
}

function tryLoadConfig(cwd: string): ReturnType<typeof loadConfig> | null {
  try {
    return loadConfig(cwd)
  } catch {
    return null
  }
}

function buildSink(cwd: string, sessionId: string, dashboardUrl?: string): EventSink {
  const sinks: EventSink[] = [new FileSink(eventsFilePath(cwd, sessionId))]
  if (dashboardUrl) sinks.push(new HttpSink(dashboardUrl, sessionId))
  return new TeeSink(sinks)
}

export async function runChat(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(CHAT_HELP)
    return 0
  }

  const args = parseChatArgs(argv)
  if (args.errors.length > 0 && !args.errors.includes("__HELP__")) {
    for (const e of args.errors) process.stderr.write(`error: ${e}\n`)
    process.stderr.write(`\n${CHAT_HELP}`)
    return 64
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd()
  const sessionId = args.sessionId!

  const unpackedSecrets = unpackAllSecrets()
  if (unpackedSecrets > 0) {
    process.stdout.write(`→ kody2: unpacked ${unpackedSecrets} secret(s) from ALL_SECRETS\n`)
  }
  resolveAuthToken()
  configureGitIdentity(cwd)

  const config = tryLoadConfig(cwd)
  const modelSpec = args.model ?? config?.agent.model ?? DEFAULT_MODEL
  let model: ReturnType<typeof parseProviderModel>
  try {
    model = parseProviderModel(modelSpec)
  } catch (err) {
    process.stderr.write(`error: invalid model '${modelSpec}': ${err instanceof Error ? err.message : String(err)}\n`)
    return 64
  }

  let litellm: Awaited<ReturnType<typeof startLitellmIfNeeded>> = null
  try {
    litellm = await startLitellmIfNeeded(model, cwd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const sink = buildSink(cwd, sessionId, args.dashboardUrl)
    await sink.emit({
      event: "chat.error",
      payload: { sessionId, error: `litellm startup failed: ${msg}` },
      runId: makeRunId(sessionId, "error"),
      emittedAt: new Date().toISOString(),
    })
    return 99
  }

  const sessionFile = sessionFilePath(cwd, sessionId)
  if (args.initMessage) seedInitialMessage(sessionFile, args.initMessage)

  const sink = buildSink(cwd, sessionId, args.dashboardUrl)

  try {
    const result = await runChatTurn({
      sessionId,
      sessionFile,
      cwd,
      model,
      litellmUrl: litellm?.url ?? null,
      sink,
      verbose: args.verbose,
      quiet: args.quiet,
    })
    commitChatFiles(cwd, sessionId, args.verbose ?? false)
    return result.exitCode
  } finally {
    try {
      litellm?.kill()
    } catch {
      /* best effort */
    }
  }
}
