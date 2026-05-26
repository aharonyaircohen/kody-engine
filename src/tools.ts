/**
 * CLI-tool contract verifier.
 *
 * For each entry in a profile's `cliTools` array:
 *   1. Run `install.checkCommand`. If it exits non-zero and
 *      install.installCommand is set, run that and re-check.
 *   2. Run `verify` (e.g. `gh auth status`). Failure aborts the run.
 *   3. If the tool is `install.required: false` and still missing after
 *      install, leave it absent (the executable tolerates its absence).
 */

import { execFileSync } from "node:child_process"
import type { CliToolSpec } from "./executables/types.js"

export interface ToolCheckResult {
  name: string
  present: boolean
  verified: boolean
  error?: string
}

export function verifyCliTools(tools: CliToolSpec[], cwd?: string): ToolCheckResult[] {
  const out: ToolCheckResult[] = []
  for (const t of tools) out.push(verifyOne(t, cwd))
  return out
}

export function firstRequiredFailure(results: ToolCheckResult[], tools: CliToolSpec[]): ToolCheckResult | null {
  for (const t of tools) {
    const r = results.find((x) => x.name === t.name)
    if (!r) continue
    if (t.install.required && (!r.present || !r.verified)) return r
  }
  return null
}

// ────────────────────────────────────────────────────────────────────────────

function verifyOne(tool: CliToolSpec, cwd?: string): ToolCheckResult {
  const result: ToolCheckResult = { name: tool.name, present: false, verified: false }

  const checkRes = runShell(tool.install.checkCommand, cwd)
  let present = checkRes.ok
  if (!present && tool.install.installCommand) {
    runShell(tool.install.installCommand, cwd, 120_000)
    present = runShell(tool.install.checkCommand, cwd).ok
  }
  result.present = present
  if (!present) {
    result.error = `tool "${tool.name}" not on PATH (check: ${tool.install.checkCommand})`
    return result
  }

  const verifyRes = runShell(tool.verify, cwd)
  result.verified = verifyRes.ok
  if (!verifyRes.ok) {
    const tail = formatStderrTail(verifyRes.stderr, verifyRes.stdout)
    result.error = `tool "${tool.name}" failed verify: ${tool.verify}${tail ? ` — ${tail}` : ""}`
  }
  return result
}

interface ShellResult {
  ok: boolean
  stdout: string
  stderr: string
}

function runShell(cmd: string, cwd?: string, timeoutMs = 30_000): ShellResult {
  try {
    const stdout = execFileSync("sh", ["-c", cmd], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      encoding: "utf-8",
    })
    return { ok: true, stdout: stdout ?? "", stderr: "" }
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string }
    const stdout = e.stdout ? e.stdout.toString() : ""
    const stderr = e.stderr ? e.stderr.toString() : ""
    return { ok: false, stdout, stderr }
  }
}

function formatStderrTail(stderr: string, stdout: string): string {
  const source = stderr.trim() || stdout.trim()
  if (!source) return ""
  // Keep the last 400 chars on one line so it doesn't bury the log.
  const flat = source.replace(/\s+/g, " ").trim()
  return flat.length > 400 ? `…${flat.slice(-400)}` : flat
}
