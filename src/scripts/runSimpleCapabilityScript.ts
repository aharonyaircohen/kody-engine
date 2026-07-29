import { spawnSync } from "node:child_process"
import * as fs from "node:fs"

import type { PreflightScript } from "../implementations/types.js"
import { buildTickChildEnv } from "./tickShellRunner.js"

const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000
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
  const capabilitySecrets = declaredSecrets(ctx.data.capabilitySecretNames, process.env)
  const result = spawnSync("bash", [scriptPath], {
    cwd: ctx.cwd,
    env: {
      ...buildTickChildEnv(process.env, false),
      ...capabilitySecrets,
      ...capabilityEnvironment,
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: SCRIPT_TIMEOUT_MS,
    maxBuffer: SCRIPT_MAX_OUTPUT_BYTES,
  })

  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
    ctx.output.exitCode = timedOut ? 124 : 99
    ctx.output.reason = timedOut
      ? "Capability script timed out after 5 minutes"
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

  try {
    ctx.data.capabilityScriptOutput = JSON.parse(result.stdout ?? "")
  } catch {
    ctx.output.exitCode = 64
    ctx.output.reason = "Capability script must return exactly one valid JSON value on stdout"
  }
}

function declaredSecrets(names: unknown, parent: NodeJS.ProcessEnv): Record<string, string> {
  if (!Array.isArray(names)) return {}
  const secrets: Record<string, string> = {}
  for (const name of names) {
    if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name)) continue
    const value = parent[name]
    if (value !== undefined) secrets[name] = value
  }
  return secrets
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
