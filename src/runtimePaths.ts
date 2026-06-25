import { createHash } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"

export function runtimeDirForCwd(cwd: string, ...parts: string[]): string {
  const key = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16)
  return path.join(os.tmpdir(), "kody-engine", key, ...parts)
}

export function runtimeStatePath(cwd: string, ...parts: string[]): string {
  const configuredRoot = process.env.KODY_RUNTIME_DIR?.trim()
  const base = configuredRoot ? path.resolve(configuredRoot) : runtimeDirForCwd(cwd)
  return path.join(base, ...parts)
}

export function agentRunDir(cwd: string): string {
  return runtimeStatePath(cwd, "agent-runs")
}

export function lastRunLogPath(cwd: string): string {
  return path.join(agentRunDir(cwd), "last-run.jsonl")
}