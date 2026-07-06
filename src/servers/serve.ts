/**
 * serveFlow — preflight for the `serve` implementation.
 *
 * Starts a LiteLLM proxy for the configured model (when the model needs one)
 * and optionally launches an editor pointed at it. Three forms:
 *
 *   kody serve          — proxy only, long-lived until Ctrl+C
 *   kody serve vscode   — proxy + launch VS Code (detaches, proxy stays
 *                          alive in foreground until Ctrl+C)
 *   kody serve claude   — proxy + launch Claude Code CLI (inherits stdio;
 *                          proxy exits when claude exits)
 *
 * VS Code / Claude Code routes through the proxy via ANTHROPIC_BASE_URL +
 * ANTHROPIC_API_KEY env vars (only set when the configured model actually
 * needs the proxy — Anthropic models go direct). Sets ctx.skipAgent — serve
 * never invokes the Kody agent.
 */

import { spawn } from "node:child_process"
import {
  getAnthropicApiKeyOrDummy,
  type KodyConfig,
  LITELLM_DEFAULT_URL,
  needsLitellmProxy,
  parseProviderModel,
} from "../config.js"
import { type LitellmHandle, startLitellmIfNeeded } from "../litellm.js"

/** Inputs the `serve` CLI verb passes in (loaded by entry.ts, not the executor). */
export interface ServeOptions {
  cwd: string
  config: KodyConfig
  args: string[]
}

export type EditorTarget = "none" | "vscode" | "claude"

/** Resolve the `serve` subcommand into an editor target. Exported for testing. */
export function parseTarget(positional: unknown): EditorTarget {
  if (!Array.isArray(positional) || positional.length === 0) return "none"
  const first = String(positional[0]).toLowerCase()
  if (first === "vscode" || first === "code") return "vscode"
  if (first === "claude") return "claude"
  throw new Error(`unknown serve subcommand: "${positional[0]}" (expected: vscode, claude, or omit)`)
}

function buildProxyEnv(url: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_API_KEY: getAnthropicApiKeyOrDummy(),
  }
}

export async function serve(opts: ServeOptions): Promise<number> {
  const target = parseTarget(opts.args)
  const model = parseProviderModel(opts.config.agent.model)
  const usesProxy = needsLitellmProxy(model)

  let handle: LitellmHandle | null = null
  if (usesProxy) {
    process.stdout.write(`[kody serve] starting LiteLLM proxy for ${model.provider}/${model.model}...\n`)
    handle = await startLitellmIfNeeded(model, opts.cwd)
    process.stdout.write(`[kody serve] LiteLLM ready at ${handle?.url ?? LITELLM_DEFAULT_URL}\n`)
  } else {
    process.stdout.write(
      `[kody serve] model ${model.provider}/${model.model} routes to Anthropic directly — no proxy needed\n`,
    )
  }

  const url = handle?.url ?? LITELLM_DEFAULT_URL
  const editorEnv = usesProxy ? buildProxyEnv(url) : { ...process.env }

  const killProxy = () => {
    if (handle) {
      process.stdout.write(`[kody serve] stopping LiteLLM proxy...\n`)
      try {
        handle.kill()
      } catch {
        /* best effort */
      }
    }
  }

  // ─── claude: synchronous foreground — exits with the editor ──────────────
  if (target === "claude") {
    process.stdout.write(`[kody serve] launching Claude Code at ${opts.cwd}\n`)
    if (usesProxy) process.stdout.write(`  ANTHROPIC_BASE_URL=${url}\n`)
    const args = ["--dangerously-skip-permissions", "--model", model.model]
    const child = spawn("claude", args, { stdio: "inherit", env: editorEnv, cwd: opts.cwd })
    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? 0))
      child.on("error", (err) => {
        process.stderr.write(`[kody serve] failed to launch Claude Code: ${err.message}\n`)
        process.stderr.write(`  Install: https://docs.anthropic.com/claude/docs/claude-code\n`)
        resolve(1)
      })
    })
    killProxy()
    return exitCode
  }

  // ─── vscode | none: launch editor (if any), then block until SIGINT ──────
  if (target === "vscode") {
    process.stdout.write(`[kody serve] launching VS Code at ${opts.cwd}\n`)
    if (usesProxy) process.stdout.write(`  ANTHROPIC_BASE_URL=${url}\n`)
    try {
      const code = spawn("code", [opts.cwd], { stdio: "inherit", env: editorEnv, detached: true })
      code.on("error", (err) => {
        process.stderr.write(`[kody serve] failed to launch VS Code: ${err.message}\n`)
        process.stderr.write(
          `  Install the 'code' CLI: VS Code → Command Palette → "Shell Command: Install 'code' command in PATH"\n`,
        )
      })
      code.unref()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody serve] failed to spawn VS Code: ${msg}\n`)
    }
  }

  process.stdout.write(`[kody serve] running. Press Ctrl+C to stop.\n`)

  // Keep the Node event loop alive — an unresolved Promise alone is not
  // enough; a no-op interval lets SIGINT/SIGTERM handlers fire when the
  // user presses Ctrl+C.
  const keepAlive = setInterval(() => {}, 60_000)

  const shutdown = (signal: NodeJS.Signals, exitCode: number) => {
    clearInterval(keepAlive)
    process.stdout.write(`[kody serve] received ${signal}\n`)
    killProxy()
    process.exit(exitCode)
  }
  process.on("SIGINT", () => shutdown("SIGINT", 130))
  process.on("SIGTERM", () => shutdown("SIGTERM", 143))

  await new Promise<void>(() => {})
  return 0 // unreachable (the promise above never resolves); satisfies the return type
}
