import { spawnSync } from "node:child_process"
import * as fs from "node:fs"

import { parseCapabilityResultsFromText } from "../capabilityResult.js"
import type { PreflightScript } from "../implementations/types.js"
import { resolveRuntimeSecrets } from "./runtimeSecrets.js"
import { buildTickChildEnv } from "./tickShellRunner.js"

const DEFAULT_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000
const SCRIPT_MAX_OUTPUT_BYTES = 1024 * 1024

export const runSimpleCapabilityScript: PreflightScript = async (ctx) => {
  ctx.skipAgent = true

  const scriptPath = typeof ctx.data.capabilityScriptPath === "string" ? ctx.data.capabilityScriptPath : ""
  if (!scriptPath || !isRegularFile(scriptPath)) {
    ctx.output.exitCode = 99
    ctx.output.reason = 'Script-backed Capability requires a regular "tools/run.sh" entrypoint'
    return
  }

  const capabilityEnvironment = isStringRecord(ctx.data.capabilityEnvironment) ? ctx.data.capabilityEnvironment : {}
  const capabilitySecrets = await resolveRuntimeSecrets(ctx.data.capabilitySecretNames, ctx)
  for (const warning of capabilitySecrets.warnings) {
    process.stderr.write(`→ kody: WARNING ${warning}\n`)
  }
  const timeoutMs =
    typeof ctx.data.capabilityScriptTimeoutMs === "number"
      ? ctx.data.capabilityScriptTimeoutMs
      : DEFAULT_SCRIPT_TIMEOUT_MS
  const result = spawnSync("bash", [scriptPath], {
    cwd: ctx.cwd,
    env: {
      ...buildTickChildEnv(process.env, false),
      ...capabilitySecrets.environment,
      ...capabilityEnvironment,
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: SCRIPT_MAX_OUTPUT_BYTES,
  })

  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
    ctx.output.exitCode = timedOut ? 124 : 99
    ctx.output.reason = timedOut
      ? `Capability script timed out after ${formatDuration(timeoutMs)}`
      : `Capability script failed to start: ${result.error.message}`
    return
  }
  if (result.signal) {
    ctx.output.exitCode = 124
    ctx.output.reason = `Capability script was killed by ${result.signal}`
    return
  }
  if (result.status !== 0) {
    ctx.output.exitCode = result.status ?? 99
    ctx.output.reason = `Capability script exited ${result.status ?? 99}`
    return
  }

  const stdout = result.stdout ?? ""
  try {
    ctx.data.capabilityScriptOutput = JSON.parse(stdout)
  } catch {
    const structuredResult = parseCapabilityResultsFromText(stdout).at(-1)
    if (structuredResult) {
      ctx.data.capabilityScriptOutput = structuredResult
      return
    }
    ctx.output.exitCode = 64
    ctx.output.reason =
      "Capability script must return exactly one valid JSON value or emit a valid KODY_CAPABILITY_RESULT marker"
  }
}

function formatDuration(timeoutMs: number): string {
  return timeoutMs % 60_000 === 0 ? `${timeoutMs / 60_000} minutes` : `${timeoutMs}ms`
}

function isRegularFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  )
}
