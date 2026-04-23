import * as fs from "node:fs"
import * as path from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { getAnthropicApiKeyOrDummy, type ProviderModel } from "./config.js"
import { renderEvent, type SdkMessageLike } from "./format.js"

export interface AgentResult {
  outcome: "completed" | "failed"
  finalText: string
  error?: string
  ndjsonPath: string
}

export interface AgentOptions {
  prompt: string
  model: ProviderModel
  cwd: string
  litellmUrl?: string | null
  verbose?: boolean
  quiet?: boolean
  ndjsonDir?: string
  /** Override the default allowed tool list (e.g. read-only for review). */
  allowedToolsOverride?: string[]
  /** Override the default permissionMode (e.g. "default" for read-only flows). */
  permissionModeOverride?: "default" | "acceptEdits" | "plan" | "bypassPermissions"
  /**
   * MCP server specs declared by the profile (claudeCode.mcpServers).
   * Transformed to the SDK's record shape (keyed by server name) before
   * being forwarded to `query()`.
   */
  mcpServers?: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }>
  /**
   * Absolute paths to plugin directories to load. Each is passed to the
   * SDK's `plugins` option as `{ type: 'local', path }`. Kody uses this
   * for both external plugins (from profile.claudeCode.plugins) and the
   * synthetic plugin built by the buildSyntheticPlugin preflight.
   */
  pluginPaths?: string[]
  /** Hard cap on agent turns. null/undefined = SDK default (unbounded). */
  maxTurns?: number | null
  /** Extended-thinking token budget. null/undefined = SDK default. */
  maxThinkingTokens?: number | null
  /** Text appended to Claude Code's baseline system prompt. */
  systemPromptAppend?: string | null
  /**
   * Filesystem sources the SDK should auto-load. `"project"` loads
   * `<cwd>/.claude/` (skills, commands, settings.json) and CLAUDE.md;
   * `"local"` loads `<cwd>/.claude/settings.local.json`; `"user"` loads
   * `~/.claude/`. Default: `["project", "local"]` so the target repo's
   * configuration is picked up. Pass `[]` for SDK isolation.
   */
  settingSources?: Array<"user" | "project" | "local">
}

const DEFAULT_ALLOWED_TOOLS = ["Bash", "Edit", "Read", "Write", "Glob", "Grep"]

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const ndjsonDir = opts.ndjsonDir ?? path.join(opts.cwd, ".kody")
  fs.mkdirSync(ndjsonDir, { recursive: true })
  const ndjsonPath = path.join(ndjsonDir, "last-run.jsonl")
  const fullLog = fs.createWriteStream(ndjsonPath, { flags: "w" })

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SKIP_HOOKS: "1",
    HUSKY: "0",
    CI: process.env.CI ?? "1",
  }
  if (opts.litellmUrl) {
    env.ANTHROPIC_BASE_URL = opts.litellmUrl
    env.ANTHROPIC_API_KEY = getAnthropicApiKeyOrDummy()
  }

  // Collect every `result` message's text. The SDK can emit multiple
  // `result` events when the session restarts mid-flight (background
  // checks, continuation turns). Keeping only the last one silently
  // clobbers earlier terminal output — including a valid DONE marker
  // from the turn that actually finished the work. Joining all of them
  // gives the parser the full terminal stream.
  const resultTexts: string[] = []
  let outcome: "completed" | "failed" = "failed"
  let errorMessage: string | undefined

  try {
    const queryOptions: Record<string, unknown> = {
      model: opts.model.model,
      cwd: opts.cwd,
      allowedTools: opts.allowedToolsOverride ?? DEFAULT_ALLOWED_TOOLS,
      permissionMode: opts.permissionModeOverride ?? "acceptEdits",
      env,
    }
    if (opts.mcpServers && opts.mcpServers.length > 0) {
      queryOptions.mcpServers = Object.fromEntries(
        opts.mcpServers.map((s) => {
          const cfg: Record<string, unknown> = { command: s.command }
          if (s.args) cfg.args = s.args
          if (s.env) cfg.env = s.env
          return [s.name, cfg]
        }),
      )
    }
    if (opts.pluginPaths && opts.pluginPaths.length > 0) {
      queryOptions.plugins = opts.pluginPaths.map((p) => ({ type: "local", path: p }))
    }
    if (typeof opts.maxTurns === "number" && opts.maxTurns > 0) {
      queryOptions.maxTurns = opts.maxTurns
    }
    if (typeof opts.maxThinkingTokens === "number" && opts.maxThinkingTokens > 0) {
      queryOptions.maxThinkingTokens = opts.maxThinkingTokens
    }
    if (typeof opts.systemPromptAppend === "string" && opts.systemPromptAppend.length > 0) {
      queryOptions.systemPrompt = { type: "preset", preset: "claude_code", append: opts.systemPromptAppend }
    }
    queryOptions.settingSources = opts.settingSources ?? ["project", "local"]
    const result = query({
      prompt: opts.prompt,
      // biome-ignore lint/suspicious/noExplicitAny: SDK options type is narrow; mcpServers is runtime-passthrough.
      options: queryOptions as any,
    })

    for await (const msg of result) {
      try {
        fullLog.write(`${JSON.stringify(msg)}\n`)
      } catch {
        /* best effort */
      }

      const line = renderEvent(msg as SdkMessageLike, { verbose: opts.verbose, quiet: opts.quiet })
      if (line) process.stdout.write(`${line}\n`)

      const m = msg as SdkMessageLike
      if (m.type === "result") {
        if (m.subtype === "success") {
          outcome = "completed"
          const text = (typeof m.result === "string" ? m.result : "").trim()
          if (text) resultTexts.push(text)
        } else {
          outcome = "failed"
          errorMessage = `result subtype: ${m.subtype ?? "unknown"}`
        }
      }
    }
  } catch (e) {
    outcome = "failed"
    errorMessage = e instanceof Error ? e.message : String(e)
  } finally {
    try {
      fullLog.end()
    } catch {
      /* best effort */
    }
  }

  const finalText = resultTexts.join("\n\n---\n\n")
  return { outcome, finalText, error: errorMessage, ndjsonPath }
}
