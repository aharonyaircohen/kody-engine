import { spawn } from "node:child_process"
import type { KodyConfig } from "./config.js"

export interface VerifyResult {
  ok: boolean
  failed: string[]
  details: Record<string, { exitCode: number; durationMs: number; tail: string }>
  /**
   * Commands that initially failed but passed on retry — i.e. caught flakes.
   * Empty when nothing was retried or all retries also failed.
   */
  recovered?: string[]
}

const TAIL_CHARS = 4000
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
/**
 * Default retry count for the `test` command. typecheck/lint/format are
 * deterministic — never retried. Two retries means up to three total
 * attempts: enough to catch a non-deterministic test that fails ~30% of
 * the time without burning budget on a real failure.
 */
export const DEFAULT_TEST_RETRIES = 2

interface RunResult {
  exitCode: number
  durationMs: number
  tail: string
}

const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|SERVICE_KEY|MASTER_KEY|CREDENTIALS?)(?:_|$)/i

/**
 * Build the environment inherited by consumer quality commands.
 *
 * Older launchers may pass repository secrets through ALL_SECRETS. Verification
 * executes agent-edited repository code, so it must not inherit those
 * credentials. Preserve normal build variables while removing the raw blob,
 * every key named by it, and credential-shaped variables from other runtime
 * sources.
 */
export function buildVerifyEnv(source: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source }
  const rawSecrets = env.ALL_SECRETS
  delete env.ALL_SECRETS

  if (rawSecrets) {
    try {
      const parsed = JSON.parse(rawSecrets) as Record<string, unknown>
      for (const key of Object.keys(parsed)) delete env[key]
    } catch {
      // Fail closed for recognizable credential names below. The launcher
      // always supplies valid JSON, but malformed input must never preserve
      // the raw blob itself.
    }
  }

  for (const key of Object.keys(env)) {
    if (SENSITIVE_ENV_NAME.test(key)) delete env[key]
  }

  env.HUSKY = "0"
  env.SKIP_HOOKS = "1"
  env.CI = source.CI ?? "1"
  return env
}

function abortMessage(signal: AbortSignal): string {
  const reason = signal.reason
  return reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "verification aborted"
}

function runCommand(command: string, cwd?: string, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    const start = Date.now()
    if (signal?.aborted) {
      resolve({ exitCode: -1, durationMs: 0, tail: abortMessage(signal) })
      return
    }
    const child = spawn(command, {
      cwd,
      shell: true,
      env: buildVerifyEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
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

    let settled = false
    const killTree = (killSignal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, killSignal)
        else child.kill(killSignal)
      } catch {
        child.kill(killSignal)
      }
    }
    const finish = (exitCode: number, extraTail = ""): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      const output = Buffer.concat(buffers).toString("utf-8")
      const tail = [output, extraTail].filter(Boolean).join("\n").slice(-TAIL_CHARS)
      resolve({ exitCode, durationMs: Date.now() - start, tail })
    }
    const terminate = (): void => {
      killTree("SIGTERM")
      setTimeout(() => killTree("SIGKILL"), 5000).unref()
    }
    const onAbort = (): void => {
      terminate()
      finish(-1, signal ? abortMessage(signal) : "verification aborted")
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    const timer = setTimeout(() => {
      terminate()
      finish(-1, "verification command timed out")
    }, COMMAND_TIMEOUT_MS)

    child.on("exit", (code) => {
      finish(code ?? -1)
    })
    child.on("error", (err) => {
      finish(-1, err.message)
    })
  })
}

export async function verifyAll(
  config: KodyConfig,
  cwd?: string,
  opts?: { signal?: AbortSignal },
): Promise<VerifyResult> {
  const commands: { name: string; cmd: string }[] = []
  if (config.quality.typecheck) commands.push({ name: "typecheck", cmd: config.quality.typecheck })
  if (config.quality.testUnit) commands.push({ name: "test", cmd: config.quality.testUnit })
  if (config.quality.lint) commands.push({ name: "lint", cmd: config.quality.lint })
  if (config.quality.format) commands.push({ name: "format", cmd: config.quality.format })

  const failed: string[] = []
  const details: Record<string, RunResult> = {}

  for (const { name, cmd } of commands) {
    const result = await runCommand(cmd, cwd, opts?.signal)
    details[name] = result
    if (result.exitCode !== 0) failed.push(name)
  }

  return { ok: failed.length === 0, failed, details }
}

/**
 * Pure rerun-on-flake helper. Takes an initial verify result and a runner
 * for the test command. Returns a new result with retries applied.
 *
 * Extracted as a pure function (no module-level dependencies) so tests can
 * exercise the retry logic without spawning real processes or mocking ES
 * module bindings.
 *
 * Only `test` is retried — typecheck/lint/format are deterministic and a
 * failure there is always real.
 */
export async function applyTestRetries(
  initial: VerifyResult,
  testCommand: string | undefined,
  cwd: string | undefined,
  runner: (cmd: string, cwd?: string, signal?: AbortSignal) => Promise<RunResult>,
  testRetries: number = DEFAULT_TEST_RETRIES,
  signal?: AbortSignal,
): Promise<VerifyResult> {
  if (initial.ok) return { ...initial, recovered: [] }
  const recovered: string[] = []
  const details = { ...initial.details }
  let failed = [...initial.failed]

  if (failed.includes("test") && testCommand && testRetries > 0) {
    for (let attempt = 1; attempt <= testRetries; attempt++) {
      if (signal?.aborted) break
      const retry = await runner(testCommand, cwd, signal)
      details[`test (retry ${attempt})`] = retry
      if (retry.exitCode === 0) {
        failed = failed.filter((f) => f !== "test")
        recovered.push("test")
        break
      }
    }
  }

  return { ok: failed.length === 0, failed, details, recovered }
}

/**
 * Wrap verifyAll with rerun-on-flake for the `test` command.
 *
 * Non-deterministic tests (e.g. a random number swap that occasionally rolls
 * the same value) caused real PRs to be aborted even when the agent's
 * change was unrelated to the failing test (see issue #1544). Retrying just
 * the test command up to N times catches the flake; if every attempt fails,
 * the failure is real and surfaces unchanged.
 */
export async function verifyAllWithRetry(
  config: KodyConfig,
  cwd?: string,
  opts?: { testRetries?: number; signal?: AbortSignal },
): Promise<VerifyResult> {
  const initial = await verifyAll(config, cwd, { signal: opts?.signal })
  return applyTestRetries(initial, config.quality.testUnit, cwd, runCommand, opts?.testRetries, opts?.signal)
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (0x1B) is required to match ANSI escape sequences.
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

export function summarizeFailure(result: VerifyResult): string {
  const lines = [`verify failed: ${result.failed.join(", ")}`]
  for (const name of result.failed) {
    const d = result.details[name]
    if (!d) continue
    lines.push(`\n--- ${name} (exit ${d.exitCode}, ${(d.durationMs / 1000).toFixed(1)}s) ---`)
    lines.push(stripAnsi(d.tail))
    // Surface retry attempts (only relevant for the `test` command — see
    // verifyAllWithRetry). Helps the user see "we tried 3 times, all red"
    // and not assume one transient failure was treated as final.
    for (let attempt = 1; ; attempt++) {
      const retry = result.details[`${name} (retry ${attempt})`]
      if (!retry) break
      lines.push(
        `\n--- ${name} (retry ${attempt}: exit ${retry.exitCode}, ${(retry.durationMs / 1000).toFixed(1)}s) ---`,
      )
      lines.push(stripAnsi(retry.tail))
    }
  }
  return lines.join("\n")
}
