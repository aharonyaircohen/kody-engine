/**
 * Shared helper for the smoke tier. Spawns the real CLI via the locally
 * installed tsx (NOT `npx tsx`, which resolves over the network and is the
 * source of the old e2e flakiness) with an explicit timeout that overrides
 * the global 30s vitest default.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import * as path from "node:path"

export const REPO_ROOT = process.cwd()
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx")
const ENTRY = path.join(REPO_ROOT, "bin", "kody.ts")

export interface CliResult {
  status: number
  stdout: string
  stderr: string
}

export function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): CliResult {
  const childEnv = { ...process.env, ...opts.env }
  if (!opts.env?.GITHUB_ACTIONS) {
    delete childEnv.GITHUB_ACTIONS
    delete childEnv.GITHUB_EVENT_NAME
    delete childEnv.GITHUB_EVENT_PATH
    delete childEnv.ACTIONS_ID_TOKEN_REQUEST_URL
    delete childEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  }
  try {
    const stdout = execFileSync(TSX, [ENTRY, ...args], {
      cwd: opts.cwd ?? REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    })
    return { status: 0, stdout, stderr: "" }
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer }
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }
  }
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }
  return pkg.version
}
