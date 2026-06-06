/**
 * bin/brain-proxy.ts
 *
 * Standalone entry point for the brain proxy. Boots the proxy and listens
 * forever. Routes to whichever backend BRAIN_BACKEND selects.
 *
 * Env:
 *   BRAIN_API_KEY          — shared secret clients send (X-Api-Key or Bearer)
 *   BRAIN_BACKEND          — "brain-serve" (default) | "hermes"
 *   BRAIN_SERVE_URL        — when backend=brain-serve (default: http://localhost:8080)
 *   HERMES_URL             — when backend=hermes (default: http://localhost:3000)
 *   BRAIN_PROXY_PORT       — port to listen on (default: 8080)
 *   BRAIN_PROXY_HOST       — host to bind (default: 0.0.0.0)
 *   MODEL                  — model identifier for Hermes (default: anthropic/claude-sonnet-4)
 *
 * Routes exposed (Brain SSE):
 *   POST /chats/:id/messages        — submit message, stream Brain SSE
 *   GET  /chats/:id/stream?since=N  — replay + live-tail (brain-serve only)
 *   GET  /healthz                   — health check (no auth)
 */

import { startBrainProxy } from "../servers/brain-proxy.js"
import { getApiKey, requireEnv } from "./_httpShared.js"

export async function brainProxy(): Promise<number> {
  requireEnv(["BRAIN_API_KEY"], "brain-proxy")

  const apiKey = getApiKey()
  if (!apiKey) {
    process.stderr.write("[brain-proxy] BRAIN_API_KEY is required\n")
    process.exit(2)
  }

  const backend = (process.env.BRAIN_BACKEND?.trim() || "brain-serve") as "brain-serve" | "hermes"
  if (backend !== "brain-serve" && backend !== "hermes") {
    process.stderr.write(`[brain-proxy] BRAIN_BACKEND must be 'brain-serve' or 'hermes', got '${backend}'\n`)
    process.exit(2)
  }

  const port = Number(process.env.BRAIN_PROXY_PORT ?? 8080)
  const host = process.env.BRAIN_PROXY_HOST ?? "0.0.0.0"
  const brainServeUrl = process.env.BRAIN_SERVE_URL?.trim() || undefined
  const hermesUrl = process.env.HERMES_URL?.trim() || undefined
  const model = process.env.MODEL?.trim() || undefined

  const proxy = await startBrainProxy({
    apiKey,
    backend,
    ...(brainServeUrl ? { brainServeUrl } : {}),
    ...(hermesUrl ? { hermesUrl } : {}),
    ...(model ? { model } : {}),
    port,
    host,
  })

  process.stdout.write(`[brain-proxy] listening on http://${host}:${port} (backend=${backend})\n`)

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      process.stdout.write(`[brain-proxy] ${sig} — shutting down\n`)
      void proxy.stop().then(() => process.exit(0))
    })
  }

  // Block forever.
  await new Promise(() => {})
  return 0
}
