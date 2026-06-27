/**
 * `kody chat` — dashboard-driven chat session entry point.
 *
 * Called from the kody.yml workflow when SESSION_ID is set (the dashboard
 * dispatched a chat message). Intentionally separate from `kody ci` —
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

import * as fs from "node:fs"
import * as path from "node:path"
import type { EventSink } from "./chat/events.js"
import { eventsFilePath, FileSink, HttpSink, makeRunId, TeeSink } from "./chat/events.js"
import { runChatTurn } from "./chat/loop.js"
import { runInteractiveMode } from "./chat/modes/interactive.js"
import { readMeta, seedInitialMessage, sessionFilePath } from "./chat/session.js"
import { persistChatFilesToState, syncChatFilesFromState } from "./chat/state-sync.js"
import {
  loadConfig,
  needsLitellmProxy,
  parseProviderModel,
  parseReasoningEffort,
  type ReasoningEffort,
} from "./config.js"
import { configureGitIdentity, installLitellmIfNeeded, resolveAuthToken, unpackAllSecrets } from "./kody-cli.js"
import { startLitellmIfNeeded } from "./litellm.js"
import { readRunRequestFromEnv } from "./run-request.js"
import { hydrateStateWorkspace } from "./stateWorkspace.js"

const DEFAULT_MODEL = "claude/claude-haiku-4-5-20251001"

export interface ChatArgs {
  sessionId?: string
  initMessage?: string
  model?: string
  dashboardUrl?: string
  cwd?: string
  reasoningEffort?: ReasoningEffort
  verbose?: boolean
  quiet?: boolean
  errors: string[]
}

export const CHAT_HELP = `kody chat — dashboard-driven chat session

Usage:
  kody chat [--session <id>] [--message <text>] [--model <provider/model>]
             [--reasoning-effort <off|low|medium|high>]
             [--dashboard-url <url>] [--cwd <path>] [--verbose|--quiet]

All inputs may also come from env: SESSION_ID, INIT_MESSAGE, MODEL, REASONING_EFFORT, DASHBOARD_URL.
CLI flags take precedence over env. SESSION_ID is required.

Thinking level maps to the Claude Agent SDK's maxThinkingTokens (Anthropic
extended thinking). Default is unset (no thinking — cheapest). Set via the
dashboard's chat-level thinking dropdown, the REASONING_EFFORT env var,
or this flag.

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
    else if (arg === "--reasoning-effort") result.reasoningEffort = parseReasoningEffort(argv[++i]) ?? undefined
    else if (arg === "--dashboard-url") result.dashboardUrl = argv[++i]
    else if (arg === "--cwd") result.cwd = argv[++i]
    else if (arg === "--verbose") result.verbose = true
    else if (arg === "--quiet") result.quiet = true
    else if (arg === "--help" || arg === "-h") result.errors.push("__HELP__")
    else if (arg?.startsWith("--")) result.errors.push(`unknown arg: ${arg}`)
    else if (arg) result.errors.push(`unexpected positional: ${arg}`)
  }

  const runRequest = readRunRequestFromEnv(env)
  if (runRequest && "error" in runRequest) result.errors.push(runRequest.error)
  const chatTarget =
    runRequest && "request" in runRequest && runRequest.request.target.type === "chat"
      ? runRequest.request.target.id
      : undefined

  // Env fallback — CLI wins.
  result.sessionId = result.sessionId ?? chatTarget
  result.sessionId = result.sessionId ?? env.SESSION_ID ?? undefined
  result.initMessage = result.initMessage ?? env.INIT_MESSAGE ?? undefined
  result.model = result.model ?? env.MODEL ?? undefined
  result.dashboardUrl = result.dashboardUrl ?? env.DASHBOARD_URL ?? undefined
  result.reasoningEffort = result.reasoningEffort ?? parseReasoningEffort(env.REASONING_EFFORT) ?? undefined

  // Normalize empty strings (GH Actions passes `""` for unset optional inputs).
  for (const key of ["sessionId", "initMessage", "model", "dashboardUrl"] as const) {
    const v = result[key]
    if (typeof v === "string" && v.trim() === "") result[key] = undefined
  }

  if (!result.sessionId && !result.errors.includes("__HELP__")) {
    result.errors.push("--session <id> (or SESSION_ID env) is required)")
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
    process.stdout.write(`→ kody: unpacked ${unpackedSecrets} secret(s) from ALL_SECRETS\n`)
  }
  await resolveAuthToken()
  configureGitIdentity(cwd)

  const config = tryLoadConfig(cwd)
  if (!config) {
    process.stderr.write("error: kody chat requires kody.config.json with configured state.repo/state.path\n")
    return 64
  }
  hydrateStateWorkspace(config, cwd)
  const modelSpec = args.model ?? config?.agent.model ?? DEFAULT_MODEL
  // Resolve reasoning effort: CLI flag → env → config default → unset.
  // Unset stays unset (no maxThinkingTokens set on the SDK call — the
  // cheapest path, no reasoning preamble).
  const reasoningEffort: ReasoningEffort | undefined =
    args.reasoningEffort ?? config?.agent.reasoningEffort ?? undefined
  let model: ReturnType<typeof parseProviderModel>
  try {
    model = parseProviderModel(modelSpec)
  } catch (err) {
    process.stderr.write(`error: invalid model '${modelSpec}': ${err instanceof Error ? err.message : String(err)}\n`)
    return 64
  }

  // Ensure LiteLLM is installed for non-anthropic providers before starting
  // the proxy. `kody ci` does this in its preflight; chat reuses the helper.
  if (needsLitellmProxy(model)) {
    const code = installLitellmIfNeeded(cwd)
    if (code !== 0) {
      process.stderr.write(`error: litellm install failed (exit ${code})\n`)
      return 99
    }
  }

  process.stdout.write(`→ kody:chat: starting litellm proxy (model=${model.provider}/${model.model})\n`)
  let litellm: Awaited<ReturnType<typeof startLitellmIfNeeded>> = null
  try {
    litellm = await startLitellmIfNeeded(model, cwd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`→ kody:chat: litellm startup FAILED: ${msg}\n`)
    const sink = buildSink(cwd, sessionId, args.dashboardUrl)
    await sink.emit({
      event: "chat.error",
      payload: { sessionId, error: `litellm startup failed: ${msg}` },
      runId: makeRunId(sessionId, "error"),
      emittedAt: new Date().toISOString(),
    })
    return 99
  }
  process.stdout.write(`→ kody:chat: litellm proxy ready (url=${litellm?.url ?? "skipped"})\n`)

  const sessionFile = sessionFilePath(cwd, sessionId)
  if (config) {
    syncChatFilesFromState(config, cwd, sessionId)
  }
  if (args.initMessage) seedInitialMessage(sessionFile, args.initMessage)

  const sink = buildSink(cwd, sessionId, args.dashboardUrl)

  // Read mode from session-file meta line. Absent meta = legacy one-shot
  // (workflow dispatch = single reply). meta.mode = "interactive" enters
  // the long-lived poll loop. Encoding mode in data (not workflow inputs)
  // keeps kody.yml a thin shim — see CLAUDE.md / feedback_thin_yaml.md.
  const meta = readMeta(sessionFile)
  process.stdout.write(
    `→ kody:chat: session file=${sessionFile} exists=${fs.existsSync(sessionFile)} meta=${meta ? meta.mode : "none"}\n`,
  )

  try {
    if (meta?.mode === "interactive") {
      const result = await runInteractiveMode({
        sessionId,
        cwd,
        model,
        litellmUrl: litellm?.url ?? null,
        sink,
        meta,
        verbose: args.verbose,
        quiet: args.quiet,
        stateConfig: config,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      })
      return result.exitCode
    }

    const result = await runChatTurn({
      sessionId,
      sessionFile,
      cwd,
      model,
      litellmUrl: litellm?.url ?? null,
      sink,
      verbose: args.verbose,
      quiet: args.quiet,
      stateConfig: config,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    })
    persistChatFilesToState(config, cwd, sessionId)
    return result.exitCode
  } finally {
    try {
      litellm?.kill()
    } catch {
      /* best effort */
    }
  }
}
