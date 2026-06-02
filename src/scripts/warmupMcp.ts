/**
 * Preflight: warm up every MCP server declared in the profile by speaking
 * the JSON-RPC handshake (`initialize` → `notifications/initialized` →
 * `tools/list`) before the agent starts. Two reasons:
 *
 *   1. Primes npm/binary caches, OS file cache, and any per-server lazy
 *      init (e.g. browser binaries) so the SDK's later spawn finishes
 *      tool discovery faster.
 *   2. Surfaces unreachable / broken MCP servers in preflight, where the
 *      operator can act on them, instead of the agent silently emitting
 *      "No such tool available" on its first turn.
 *
 * Behavior:
 *   - For each server, spawn the configured command/args, complete the
 *     MCP initialize handshake, request the tool list, then kill the
 *     subprocess. Per-server budget: 60s.
 *   - Logs `[kody warmup] <name>: N tools` on success.
 *   - Logs `[kody warmup] <name> FAILED: <reason>` on failure.
 *   - NEVER throws or fails the run. Warmup is informational + best
 *     effort. The SDK still owns the real MCP lifecycle for the agent
 *     session — this script just primes the path it walks.
 */

import { spawn } from "node:child_process"
import type { PreflightScript } from "../executables/types.js"

const PER_SERVER_TIMEOUT_MS = 60_000
const PER_REQUEST_TIMEOUT_MS = 20_000

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id?: number | string
  result?: unknown
  error?: { code: number; message: string }
}

export const warmupMcp: PreflightScript = async (_ctx, profile) => {
  const servers = profile.claudeCode.mcpServers ?? []
  if (servers.length === 0) return

  for (const s of servers) {
    const start = Date.now()
    try {
      const result = await warmupOne(s.command, s.args ?? [], s.env)
      const ms = Date.now() - start
      process.stderr.write(`[kody warmup] ${s.name}: ${result.toolCount} tools (${ms}ms)\n`)
    } catch (err) {
      const ms = Date.now() - start
      const reason = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody warmup] ${s.name} FAILED after ${ms}ms: ${reason}\n`)
    }
  }
}

async function warmupOne(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
): Promise<{ toolCount: number }> {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
  })

  let stderrBuf = ""
  child.stderr.on("data", (b: Buffer) => {
    stderrBuf += b.toString("utf8")
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096)
  })

  const overallDeadline = Date.now() + PER_SERVER_TIMEOUT_MS
  const lines = lineStream(child.stdout)

  let nextId = 1
  const send = (method: string, params?: unknown): number => {
    const id = nextId++
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
    child.stdin.write(payload)
    return id
  }
  const notify = (method: string, params?: unknown): void => {
    const payload = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`
    child.stdin.write(payload)
  }
  const awaitResponse = async (id: number): Promise<JsonRpcResponse> => {
    const reqDeadline = Math.min(Date.now() + PER_REQUEST_TIMEOUT_MS, overallDeadline)
    while (Date.now() < reqDeadline) {
      const line = await lines.next(reqDeadline - Date.now())
      if (line === null) break
      let msg: JsonRpcResponse | null = null
      try {
        msg = JSON.parse(line) as JsonRpcResponse
      } catch {
        continue
      }
      if (msg && msg.id === id) return msg
    }
    throw new Error(`request id=${id} timed out (stderr tail: ${stderrBuf.trim().slice(-300) || "(empty)"})`)
  }

  try {
    const initId = send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "kody-warmup", version: "0.1.0" },
    })
    const initResp = await awaitResponse(initId)
    if (initResp.error) throw new Error(`initialize error: ${initResp.error.message}`)

    notify("notifications/initialized")

    const listId = send("tools/list")
    const listResp = await awaitResponse(listId)
    if (listResp.error) throw new Error(`tools/list error: ${listResp.error.message}`)

    const tools = (listResp.result as { tools?: unknown[] } | undefined)?.tools
    const toolCount = Array.isArray(tools) ? tools.length : 0
    if (toolCount === 0) throw new Error("tools/list returned 0 tools")

    return { toolCount }
  } finally {
    try {
      child.kill("SIGTERM")
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
    }, 2000).unref()
  }
}

/**
 * Tiny line iterator over a Readable stream. Buffers partial lines, yields
 * complete ones via .next(timeoutMs). Returns null on timeout or EOF.
 */
function lineStream(stream: NodeJS.ReadableStream): { next: (timeoutMs: number) => Promise<string | null> } {
  let buf = ""
  const queue: string[] = []
  let waiter: ((line: string | null) => void) | null = null
  let ended = false

  const tryDeliver = (): void => {
    if (waiter && queue.length > 0) {
      const w = waiter
      waiter = null
      w(queue.shift()!)
    } else if (waiter && ended) {
      const w = waiter
      waiter = null
      w(null)
    }
  }

  stream.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    let idx = buf.indexOf("\n")
    while (idx >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "")
      buf = buf.slice(idx + 1)
      if (line.length > 0) queue.push(line)
      idx = buf.indexOf("\n")
    }
    tryDeliver()
  })
  stream.on("end", () => {
    if (buf.length > 0) {
      queue.push(buf)
      buf = ""
    }
    ended = true
    tryDeliver()
  })

  return {
    next: (timeoutMs: number) =>
      new Promise<string | null>((resolve) => {
        if (queue.length > 0) {
          resolve(queue.shift()!)
          return
        }
        if (ended) {
          resolve(null)
          return
        }
        waiter = resolve
        const t = setTimeout(
          () => {
            if (waiter === resolve) {
              waiter = null
              resolve(null)
            }
          },
          Math.max(0, timeoutMs),
        )
        t.unref?.()
      }),
  }
}
