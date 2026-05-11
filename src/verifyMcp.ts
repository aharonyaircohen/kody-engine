/**
 * In-process MCP server exposing a `verify` tool to the agent (Phase 3).
 *
 * Lets the agent close the verify→fix loop inside one SDK session: when
 * the model believes it's done, it calls `verify()`; if `ok: false`,
 * it reads the truncated failure list, edits, commits, and calls
 * `verify()` again. The postflight `verify` script still runs after
 * the session ends as the final ratifier — this tool exists to make
 * the inner loop tight instead of forcing a fix-ci cold restart.
 *
 * The server is constructed per-runAgent invocation (not module-level)
 * because each call binds the live KodyConfig + cwd + a per-call
 * attempt counter. It uses `createSdkMcpServer` (in-process) so we
 * don't spawn a subprocess.
 */

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type { KodyConfig } from "./config.js"
import { emitEvent } from "./events.js"
import { type VerifyResult, verifyAllWithRetry } from "./verify.js"

/** Hard cap on tool calls per agent session. */
export const DEFAULT_MAX_VERIFY_ATTEMPTS = 4
/** Cap the tool's stringified result to keep the agent's context tight. */
const MAX_RESULT_BYTES = 2048
/** Per-failure tail cap in the truncated result. */
const PER_FAILURE_TAIL_CHARS = 600

interface VerifyToolOptions {
  config: KodyConfig
  cwd: string
  executable: string
  maxAttempts?: number
  /** Test hook: override the verifier (used by unit tests to inject results). */
  __runVerify?: (config: KodyConfig, cwd: string) => Promise<VerifyResult>
}

interface VerifyToolState {
  attempts: number
  maxAttempts: number
}

/**
 * Build an in-process MCP server with one tool: `verify`. Returns
 * the config object the SDK accepts in `mcpServers["kody-verify"]`.
 */
export function buildVerifyMcpServer(opts: VerifyToolOptions): McpSdkServerConfigWithInstance {
  const state: VerifyToolState = {
    attempts: 0,
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_VERIFY_ATTEMPTS,
  }
  const runVerify = opts.__runVerify ?? verifyAllWithRetry

  const verifyTool = tool(
    "verify",
    "Run the project's quality gates (typecheck, lint, tests). Returns ok=true with empty failures when everything passes. Call this before declaring DONE. If ok=false, read the truncated failures, fix the code, commit, and call verify() again. You have a bounded number of attempts; after that the tool stops accepting calls and you must wrap up with whatever state is current.",
    {},
    async (_args, _extra) => {
      state.attempts++
      const attempt = state.attempts
      if (attempt > state.maxAttempts) {
        emitEvent(opts.cwd, {
          executable: opts.executable,
          kind: "error",
          name: "verify_tool",
          outcome: "failed",
          meta: { reason: "budget exhausted", attempts: attempt, maxAttempts: state.maxAttempts },
        })
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                locked: true,
                reason: `verify budget exhausted (${state.maxAttempts} attempts used)`,
              }),
            },
          ],
        }
      }
      const startedAt = Date.now()
      const result = await runVerify(opts.config, opts.cwd)
      const durationMs = Date.now() - startedAt
      emitEvent(opts.cwd, {
        executable: opts.executable,
        kind: "postflight",
        name: `verify_attempt_${attempt}`,
        durationMs,
        outcome: result.ok ? "ok" : "failed",
        meta: {
          attempt,
          failureCount: result.failed.length,
          recovered: result.recovered ?? [],
        },
      })
      const payload = truncateVerifyResult(result, state, attempt)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload),
          },
        ],
      }
    },
  )

  return createSdkMcpServer({
    name: "kody-verify",
    version: "0.1.0",
    tools: [verifyTool],
  })
}

/** Public test seam: build a result payload without running the SDK. */
export function truncateVerifyResult(
  result: VerifyResult,
  state: VerifyToolState,
  attempt: number,
): {
  ok: boolean
  attempt: number
  attemptsRemaining: number
  failures: Array<{ name: string; exitCode: number; tail: string }>
  recovered?: string[]
} {
  const failures = result.failed.slice(0, 5).map((name) => {
    const detail = result.details[name]
    const tail = detail?.tail ?? ""
    return {
      name,
      exitCode: detail?.exitCode ?? -1,
      tail: tail.length > PER_FAILURE_TAIL_CHARS ? `…${tail.slice(-PER_FAILURE_TAIL_CHARS)}` : tail,
    }
  })
  const payload = {
    ok: result.ok,
    attempt,
    attemptsRemaining: Math.max(0, state.maxAttempts - attempt),
    failures,
    ...(result.recovered && result.recovered.length > 0 ? { recovered: result.recovered } : {}),
  }
  const json = JSON.stringify(payload)
  if (json.length <= MAX_RESULT_BYTES) return payload
  // Shed per-failure tails until we fit. Preserve names and exit codes —
  // they're what the agent needs to find the right files.
  for (const f of payload.failures) {
    f.tail = f.tail.slice(-Math.max(120, Math.floor(PER_FAILURE_TAIL_CHARS / 4)))
    if (JSON.stringify(payload).length <= MAX_RESULT_BYTES) return payload
  }
  // Last resort: drop all tails.
  for (const f of payload.failures) f.tail = ""
  return payload
}

/** Re-exported for tests that need to instantiate state without the SDK. */
export type { VerifyToolState }
// Suppress unused-import lint in environments where z is required only by the
// SDK type narrowing (the `tool()` helper threads zod schemas internally).
void z
