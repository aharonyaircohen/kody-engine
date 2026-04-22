/**
 * `kody2 chat` — dashboard-driven persistent chat session.
 *
 * Called from the kody2.yml workflow when SESSION_ID is set. The runner
 * long-polls the dashboard for new user turns, runs one agent reply per
 * turn, and pushes events back. Exits on idle-timeout, hard-timeout, or
 * a terminal agent error. No git reads/writes — chat is ephemeral;
 * transcripts live in dashboard memory + this runner's heap.
 *
 * Flow:
 *  1. Light preflight (unpack ALL_SECRETS, resolve auth token, configure git).
 *  2. Resolve model (CLI flag > config > default).
 *  3. Start LiteLLM proxy for non-anthropic providers.
 *  4. Long-poll loop: pull → agent → push; exit on idle timeout.
 */

import * as path from "node:path"
import { HttpSink, makeRunId } from "./chat/events.js"
import type { EventSink } from "./chat/events.js"
import { runChatSession } from "./chat/loop.js"
import { createPullClient } from "./chat/pull.js"
import { loadConfig, needsLitellmProxy, parseProviderModel } from "./config.js"
import { configureGitIdentity, installLitellmIfNeeded, resolveAuthToken, unpackAllSecrets } from "./kody2-cli.js"
import { startLitellmIfNeeded } from "./litellm.js"

const DEFAULT_MODEL = "claude/claude-haiku-4-5-20251001"

export interface ChatArgs {
  sessionId?: string
  model?: string
  dashboardUrl?: string
  cwd?: string
  verbose?: boolean
  quiet?: boolean
  errors: string[]
}

export const CHAT_HELP = `kody2 chat — dashboard-driven chat session

Usage:
  kody2 chat [--session <id>] [--model <provider/model>]
             [--dashboard-url <url>] [--cwd <path>] [--verbose|--quiet]

All inputs may also come from env: SESSION_ID, MODEL, DASHBOARD_URL.
CLI flags take precedence over env. SESSION_ID and DASHBOARD_URL are required
(the runner long-polls the dashboard for user turns and pushes events back).

Exit codes:
  0   session exited cleanly (idle or hard timeout)
  64  bad inputs
  99  runtime failure (agent crash, pull failure, LiteLLM failure)
`

export function parseChatArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ChatArgs {
  const result: ChatArgs = { errors: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--session") result.sessionId = argv[++i]
    else if (arg === "--model") result.model = argv[++i]
    else if (arg === "--dashboard-url") result.dashboardUrl = argv[++i]
    else if (arg === "--cwd") result.cwd = argv[++i]
    else if (arg === "--verbose") result.verbose = true
    else if (arg === "--quiet") result.quiet = true
    else if (arg === "--help" || arg === "-h") result.errors.push("__HELP__")
    else if (arg?.startsWith("--")) result.errors.push(`unknown arg: ${arg}`)
    else if (arg) result.errors.push(`unexpected positional: ${arg}`)
  }

  result.sessionId = result.sessionId ?? env.SESSION_ID ?? undefined
  result.model = result.model ?? env.MODEL ?? undefined
  result.dashboardUrl = result.dashboardUrl ?? env.DASHBOARD_URL ?? undefined

  // Normalize empty strings (GH Actions passes `""` for unset optional inputs).
  for (const key of ["sessionId", "model", "dashboardUrl"] as const) {
    const v = result[key]
    if (typeof v === "string" && v.trim() === "") result[key] = undefined
  }

  if (!result.errors.includes("__HELP__")) {
    if (!result.sessionId) result.errors.push("--session <id> (or SESSION_ID env) is required")
    if (!result.dashboardUrl) result.errors.push("--dashboard-url <url> (or DASHBOARD_URL env) is required")
  }

  return result
}

function tryLoadConfig(cwd: string): ReturnType<typeof loadConfig> | null {
  try {
    return loadConfig(cwd)
  } catch {
    return null
  }
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
  const dashboardUrl = args.dashboardUrl!

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

  if (needsLitellmProxy(model)) {
    const code = installLitellmIfNeeded(cwd)
    if (code !== 0) {
      process.stderr.write(`error: litellm install failed (exit ${code})\n`)
      return 99
    }
  }

  let sink: EventSink
  try {
    sink = new HttpSink(dashboardUrl, sessionId)
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    return 64
  }

  let litellm: Awaited<ReturnType<typeof startLitellmIfNeeded>> = null
  try {
    litellm = await startLitellmIfNeeded(model, cwd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await sink.emit({
      event: "chat.error",
      payload: { sessionId, error: `litellm startup failed: ${msg}` },
      runId: makeRunId(sessionId, "error"),
      emittedAt: new Date().toISOString(),
    })
    return 99
  }

  let pull: ReturnType<typeof createPullClient>
  try {
    pull = createPullClient({ baseUrl: dashboardUrl, sessionId })
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    try { litellm?.kill() } catch { /* best effort */ }
    return 64
  }

  process.stdout.write(`→ kody2 chat: session ${sessionId}, model ${model.provider}/${model.model}\n`)

  try {
    const result = await runChatSession({
      sessionId,
      cwd,
      model,
      litellmUrl: litellm?.url ?? null,
      sink,
      pull,
      verbose: args.verbose,
      quiet: args.quiet,
    })
    process.stdout.write(`→ kody2 chat: exited (${result.reason ?? "ok"}) after ${result.turnsProcessed} turn(s)\n`)
    return result.exitCode
  } finally {
    try {
      litellm?.kill()
    } catch {
      /* best effort */
    }
  }
}
