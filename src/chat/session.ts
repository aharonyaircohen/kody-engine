/**
 * Chat session file I/O.
 *
 * Sessions are JSONL at `<cwd>/.kody/sessions/<sessionId>.jsonl`, one JSON
 * object per line with the shape produced by the Kody-Dashboard UI.
 *
 * The dashboard writes the latest turn through the GitHub Contents API before
 * dispatching the workflow, so when chat runs the file is already seeded.
 * We only append assistant turns here.
 */

import * as fs from "node:fs"
import * as path from "node:path"

export interface ChatTurn {
  role: "user" | "assistant"
  content: string
  timestamp: string
  toolCalls?: unknown[]
}

export function sessionFilePath(cwd: string, sessionId: string): string {
  return path.join(cwd, ".kody", "sessions", `${sessionId}.jsonl`)
}

export function readSession(file: string): ChatTurn[] {
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, "utf-8").trim()
  if (!raw) return []
  const turns: ChatTurn[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as ChatTurn
      if (parsed.role !== "user" && parsed.role !== "assistant") continue
      if (typeof parsed.content !== "string") continue
      turns.push(parsed)
    } catch {
      // Skip malformed lines rather than fail the whole session.
    }
  }
  return turns
}

export function appendTurn(file: string, turn: ChatTurn): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const line = JSON.stringify({
    role: turn.role,
    content: turn.content,
    timestamp: turn.timestamp,
    toolCalls: turn.toolCalls ?? [],
  })
  fs.appendFileSync(file, `${line}\n`)
}

/**
 * Seed an initial user message from workflow input. The dashboard normally
 * writes the turn before dispatch, but the workflow also accepts a raw
 * `message` input so the flow works for manual GitHub workflow_dispatch too.
 * Skip when the trailing user turn already matches to avoid duplication.
 */
export function seedInitialMessage(file: string, message: string): boolean {
  if (!message.trim()) return false
  const turns = readSession(file)
  const lastUser = [...turns].reverse().find((t) => t.role === "user")
  if (lastUser && lastUser.content === message) return false
  appendTurn(file, {
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
  })
  return true
}
