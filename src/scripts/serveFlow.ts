/**
 * serveFlow — preflight for the `serve` executable.
 *
 * Starts a LiteLLM proxy for the configured model (when the model needs one)
 * and launches VS Code with ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY pointed
 * at the proxy, so the editor's Claude Code extension routes through Kody's
 * LiteLLM. Sets ctx.skipAgent — serve never invokes the Kody agent.
 *
 * Long-lived: returns a never-resolving promise so the executor stays alive
 * until SIGINT/SIGTERM, at which point the proxy is killed and the process
 * exits.
 */

import { spawn } from "node:child_process"
import { getAnthropicApiKeyOrDummy, LITELLM_DEFAULT_URL, needsLitellmProxy, parseProviderModel } from "../config.js"
import type { PreflightScript } from "../executables/types.js"
import { type LitellmHandle, startLitellmIfNeeded } from "../litellm.js"

export const serveFlow: PreflightScript = async (ctx) => {
  ctx.skipAgent = true

  const model = parseProviderModel(ctx.config.agent.model)
  const usesProxy = needsLitellmProxy(model)

  let handle: LitellmHandle | null = null
  if (usesProxy) {
    process.stdout.write(`[kody serve] starting LiteLLM proxy for ${model.provider}/${model.model}...\n`)
    handle = await startLitellmIfNeeded(model, ctx.cwd)
    process.stdout.write(`[kody serve] LiteLLM ready at ${handle?.url ?? LITELLM_DEFAULT_URL}\n`)
  } else {
    process.stdout.write(`[kody serve] model ${model.provider}/${model.model} routes to Anthropic directly — no proxy needed\n`)
  }

  const url = handle?.url ?? LITELLM_DEFAULT_URL
  const noEditor = ctx.args.noEditor === true

  if (!noEditor) {
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (usesProxy) {
      env.ANTHROPIC_BASE_URL = url
      env.ANTHROPIC_API_KEY = getAnthropicApiKeyOrDummy()
    }
    process.stdout.write(`[kody serve] launching VS Code at ${ctx.cwd}\n`)
    if (usesProxy) process.stdout.write(`  ANTHROPIC_BASE_URL=${url}\n`)
    try {
      const code = spawn("code", [ctx.cwd], { stdio: "inherit", env, detached: true })
      code.on("error", (err) => {
        process.stderr.write(`[kody serve] failed to launch VS Code: ${err.message}\n`)
        process.stderr.write(`  Install the 'code' CLI: VS Code → Command Palette → "Shell Command: Install 'code' command in PATH"\n`)
      })
      code.unref()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody serve] failed to spawn VS Code: ${msg}\n`)
    }
  }

  process.stdout.write(`[kody serve] running. Press Ctrl+C to stop.\n`)

  // Keep the Node event loop alive. An unresolved Promise alone is not
  // enough — Node will exit when the loop is empty even with a pending
  // Promise. A no-op interval is the cheapest way to keep the loop ticking
  // and let SIGINT/SIGTERM handlers fire when the user presses Ctrl+C.
  const keepAlive = setInterval(() => {}, 60_000)

  const cleanup = (signal: NodeJS.Signals, exitCode: number) => {
    clearInterval(keepAlive)
    if (handle) {
      process.stdout.write(`[kody serve] received ${signal}, stopping LiteLLM proxy...\n`)
      try {
        handle.kill()
      } catch {
        /* best effort */
      }
    }
    process.exit(exitCode)
  }
  process.on("SIGINT", () => cleanup("SIGINT", 130))
  process.on("SIGTERM", () => cleanup("SIGTERM", 143))

  // Block forever — the executor stays alive until a signal triggers cleanup().
  await new Promise<void>(() => {})
}
