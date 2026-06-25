/**
 * Sync chat JSONL files between the runner's local temp files and the
 * configured Kody state repo. The local files remain the runtime cache; the
 * durable source lives under <state.path>/sessions and <state.path>/events.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { readStateText, type StateRepoConfig, writeStateText } from "../stateRepo.js"
import { eventsFilePath, eventsStatePath } from "./events.js"
import { sessionFilePath, sessionStatePath } from "./session.js"

function jsonlLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0)
}

function renderJsonl(lines: string[]): string {
  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

function mergeJsonl(localText: string, remoteText: string): string {
  const localLines = jsonlLines(localText)
  const seen = new Set(localLines)
  const remoteOnly = jsonlLines(remoteText).filter((line) => !seen.has(line))
  return renderJsonl([...localLines, ...remoteOnly])
}

export function syncJsonlFileFromState(opts: {
  config: StateRepoConfig
  cwd: string
  statePath: string
  localPath: string
}): void {
  const remote = readStateText(opts.config, opts.cwd, opts.statePath)
  if (!remote) return
  const local = fs.existsSync(opts.localPath) ? fs.readFileSync(opts.localPath, "utf-8") : ""
  const next = mergeJsonl(local, remote.content)
  if (next === local) return
  fs.mkdirSync(path.dirname(opts.localPath), { recursive: true })
  fs.writeFileSync(opts.localPath, next)
}

export function persistJsonlFileToState(opts: {
  config: StateRepoConfig
  cwd: string
  statePath: string
  localPath: string
  message: string
}): void {
  if (!fs.existsSync(opts.localPath)) return
  const localText = fs.readFileSync(opts.localPath, "utf-8")

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const remote = readStateText(opts.config, opts.cwd, opts.statePath)
    const body = mergeJsonl(localText, remote?.content ?? "")
    try {
      writeStateText(opts.config, opts.cwd, opts.statePath, body, opts.message, remote?.sha)
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const conflict = /HTTP 409/i.test(msg) || /HTTP 422/i.test(msg) || /does not match|is at|but expected/i.test(msg)
      if (!conflict || attempt === 3) throw err
    }
  }
}

export function syncChatFilesFromState(config: StateRepoConfig, cwd: string, sessionId: string): void {
  syncJsonlFileFromState({
    config,
    cwd,
    statePath: sessionStatePath(sessionId),
    localPath: sessionFilePath(cwd, sessionId),
  })
  syncJsonlFileFromState({
    config,
    cwd,
    statePath: eventsStatePath(sessionId),
    localPath: eventsFilePath(cwd, sessionId),
  })
}

export function syncChatSessionFromState(config: StateRepoConfig, cwd: string, sessionId: string): void {
  syncJsonlFileFromState({
    config,
    cwd,
    statePath: sessionStatePath(sessionId),
    localPath: sessionFilePath(cwd, sessionId),
  })
}

export function persistChatFilesToState(
  config: StateRepoConfig,
  cwd: string,
  sessionId: string,
  message = `chat: reply for ${sessionId}`,
): void {
  persistJsonlFileToState({
    config,
    cwd,
    statePath: sessionStatePath(sessionId),
    localPath: sessionFilePath(cwd, sessionId),
    message,
  })
  persistJsonlFileToState({
    config,
    cwd,
    statePath: eventsStatePath(sessionId),
    localPath: eventsFilePath(cwd, sessionId),
    message,
  })
}
