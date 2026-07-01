/**
 * Postflight (reproduce-only): run the project's test command and assert
 * that the new repro test fails for the right reason.
 *
 * The reproduce executable's contract is the OPPOSITE of the standard
 * `verify` postflight: a passing test suite means the repro didn't actually
 * reproduce the bug. We therefore replace `verify` in the reproduce flow
 * with this script.
 *
 * Success condition (REPRODUCE_COMPLETED stays):
 *   - Test command exit code is non-zero AND
 *   - Output contains FAILURE_SIGNATURE.messageContains AND
 *   - (if specified) Output contains FAILURE_SIGNATURE.errorType
 *
 * Otherwise we downgrade to REPRODUCE_FAILED with a specific reason so the
 * orchestrator records the truth and finishFlow doesn't post success for a
 * green run.
 *
 * The test command is read from kody.config.json's `quality.testUnit`. We
 * append the test path when the command looks like vitest/jest/pytest
 * (positional file arg supported); otherwise we run the full suite. Either
 * way, the signature substring match is what gates success.
 */

import { spawn } from "node:child_process"
import type { PostflightScript } from "../executables/types.js"
import type { Action } from "../state.js"
import type { ReproFailureSignature } from "./parseReproOutput.js"

const TEST_TIMEOUT_MS = 10 * 60 * 1000
const TAIL_CHARS = 8000
// biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC (\x1B) control char is intentional — this strips ANSI terminal color codes from captured output
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g

interface RunResult {
  exitCode: number
  output: string
}

export const verifyReproFails: PostflightScript = async (ctx) => {
  // Skip if parseReproOutput already downgraded.
  if (ctx.data.agentDone === false) return

  const testPath = (ctx.data.reproTestPath as string | undefined) ?? ""
  const signatureRaw = (ctx.data.reproFailureSignature as string | undefined) ?? ""
  if (!testPath || !signatureRaw) {
    downgrade(ctx, "verifyReproFails: missing testPath or signature in ctx.data")
    return
  }

  let signature: ReproFailureSignature
  try {
    signature = JSON.parse(signatureRaw) as ReproFailureSignature
  } catch {
    downgrade(ctx, "verifyReproFails: failure signature is not valid JSON")
    return
  }

  const baseCmd = ctx.config.quality.testUnit
  if (!baseCmd) {
    downgrade(ctx, "verifyReproFails: kody.config.json quality.testUnit is empty — cannot run repro test")
    return
  }

  const cmd = composeTestCommand(baseCmd, testPath)
  const result = await runCommand(cmd, ctx.cwd)
  const output = stripAnsi(result.output)

  ctx.data.reproVerifyExitCode = result.exitCode
  ctx.data.reproVerifyTail = output.slice(-TAIL_CHARS)

  if (result.exitCode === 0) {
    downgrade(
      ctx,
      `verifyReproFails: repro test at \`${testPath}\` exited 0 — the test should be failing because the bug is unfixed`,
    )
    return
  }

  const haystack = output.toLowerCase()
  const messageOk = signature.messageContains.length === 0 || haystack.includes(signature.messageContains.toLowerCase())
  const errorTypeOk = signature.errorType.length === 0 || haystack.includes(signature.errorType.toLowerCase())

  if (!messageOk || !errorTypeOk) {
    const missing: string[] = []
    if (!messageOk) missing.push(`messageContains="${signature.messageContains}"`)
    if (!errorTypeOk) missing.push(`errorType="${signature.errorType}"`)
    downgrade(
      ctx,
      `verifyReproFails: repro test failed but the failure signature did not match (missing ${missing.join(", ")}) — the test may be failing for the wrong reason (e.g. import or syntax error)`,
    )
    return
  }

  ctx.data.reproVerified = true
}

function composeTestCommand(baseCmd: string, testPath: string): string {
  const trimmed = baseCmd.trim()
  const lower = trimmed.toLowerCase()
  // Heuristic: known runners that accept positional file args. For unknown
  // commands fall back to running the full suite.
  const positionalRunners = ["vitest", "jest", "pytest", "mocha", "ava", "deno test", "bun test"]
  if (positionalRunners.some((r) => lower.includes(r))) {
    return `${trimmed} ${shellQuote(testPath)}`
  }
  return trimmed
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

function runCommand(command: string, cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1", CI: process.env.CI ?? "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })

    const buffers: Buffer[] = []
    let totalSize = 0
    const collect = (chunk: Buffer): void => {
      buffers.push(chunk)
      totalSize += chunk.length
      while (totalSize > TAIL_CHARS * 4 && buffers.length > 1) {
        totalSize -= buffers[0]!.length
        buffers.shift()
      }
    }

    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL")
      }, 5000)
    }, TEST_TIMEOUT_MS)

    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, output: Buffer.concat(buffers).toString("utf-8") })
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ exitCode: -1, output: err.message })
    })
  })
}

function downgrade(ctx: { data: Record<string, unknown> }, reason: string): void {
  const action = ctx.data.action as Action | undefined
  if (action?.type.endsWith("_COMPLETED")) {
    ctx.data.action = {
      type: action.type.replace(/_COMPLETED$/, "_FAILED"),
      payload: { reason, downgradedFrom: action.type },
      timestamp: new Date().toISOString(),
    }
  }
  ctx.data.agentFailureReason = reason
  ctx.data.agentDone = false
}
