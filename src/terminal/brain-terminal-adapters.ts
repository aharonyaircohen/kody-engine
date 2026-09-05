import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type {
  BrainTerminalMetadataStore,
  BrainTerminalRuntime,
  StoredBrainTerminalSession,
} from "./brain-terminal-session.js"

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export type RunTerminalCommand = (command: string, args: string[], input?: string) => Promise<CommandResult>

export function runTerminalCommand(command: string, args: string[], input?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

function storeKey(id: string): string {
  return createHash("sha256").update(id).digest("hex")
}

function isStoredSession(value: unknown): value is StoredBrainTerminalSession {
  if (!value || typeof value !== "object") return false
  const session = value as Partial<StoredBrainTerminalSession>
  return (
    session.version === 1 &&
    typeof session.id === "string" &&
    typeof session.sessionName === "string" &&
    typeof session.cwd === "string" &&
    Number.isInteger(session.generation) &&
    Number.isInteger(session.revision) &&
    typeof session.output === "string" &&
    typeof session.scope?.owner === "string" &&
    typeof session.scope?.repo === "string" &&
    typeof session.scope?.conversationId === "string"
  )
}

export class FileBrainTerminalMetadataStore implements BrainTerminalMetadataStore {
  constructor(private readonly root: string) {}

  private file(id: string): string {
    return path.join(this.root, `${storeKey(id)}.json`)
  }

  async read(id: string): Promise<StoredBrainTerminalSession | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file(id), "utf8"))
      if (!isStoredSession(parsed) || parsed.id !== id) {
        throw new Error("stored terminal session is invalid")
      }
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  }

  async write(session: StoredBrainTerminalSession): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const target = this.file(session.id)
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
    await writeFile(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600 })
    await rename(temporary, target)
  }
}

function commandError(action: string, result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
  return new Error(`tmux ${action} failed: ${detail.slice(0, 500)}`)
}

export class TmuxBrainTerminalRuntime implements BrainTerminalRuntime {
  constructor(private readonly run: RunTerminalCommand = runTerminalCommand) {}

  private async tmux(action: string, args: string[], input?: string): Promise<CommandResult> {
    const result = await this.run("tmux", args, input)
    if (result.code !== 0) throw commandError(action, result)
    return result
  }

  async start(sessionName: string, cwd: string, cols: number, rows: number): Promise<{ processId: number }> {
    await this.tmux("start", [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-x",
      String(cols),
      "-y",
      String(rows),
      "-c",
      cwd,
      "/bin/bash",
      "-l",
    ])
    await this.tmux("configure", ["set-option", "-t", sessionName, "status", "off"])
    await this.tmux("configure", ["set-option", "-t", sessionName, "history-limit", "50000"])
    await this.tmux("configure", ["set-option", "-w", "-t", sessionName, "remain-on-exit", "on"])
    const inspected = await this.inspect(sessionName)
    if (!inspected.alive || inspected.processId === null) throw new Error("tmux terminal did not start")
    return { processId: inspected.processId }
  }

  async inspect(sessionName: string): Promise<{ alive: boolean; processId: number | null }> {
    const result = await this.run("tmux", ["list-panes", "-t", sessionName, "-F", "#{pane_dead}:#{pane_pid}"])
    if (result.code !== 0) return { alive: false, processId: null }
    const [dead, pid] = result.stdout.trim().split(":")
    const processId = Number(pid)
    return {
      alive: dead === "0" && Number.isInteger(processId) && processId > 0,
      processId: Number.isInteger(processId) && processId > 0 ? processId : null,
    }
  }

  async capture(sessionName: string): Promise<string> {
    // Capture physical rows and cursor together. Joining wrapped lines or
    // replaying the final newline moves xterm away from the real shell cursor.
    const result = await this.tmux("capture", [
      "capture-pane",
      "-p",
      "-e",
      "-S",
      "-50000",
      "-t",
      sessionName,
      ";",
      "display-message",
      "-p",
      "-t",
      sessionName,
      "#{cursor_x}:#{cursor_y}:#{cursor_flag}:#{alternate_on}",
    ])
    const metadata = /\n(\d+):(\d+):([01]):([01])\n?$/.exec(result.stdout)
    if (!metadata) throw new Error("tmux capture did not include cursor position")
    const screen = result.stdout.slice(0, metadata.index)
    const col = Number(metadata[1]) + 1
    const row = Number(metadata[2]) + 1
    return `${screen}\u001b[${row};${col}H\u001b[?25${metadata[3] === "1" ? "h" : "l"}`
  }

  async input(sessionName: string, data: string): Promise<void> {
    const bufferName = `kody_${randomBytes(8).toString("hex")}`
    await this.tmux(
      "input",
      ["load-buffer", "-b", bufferName, "-", ";", "paste-buffer", "-d", "-b", bufferName, "-t", sessionName],
      data,
    )
  }

  async resize(sessionName: string, cols: number, rows: number): Promise<void> {
    await this.tmux("resize", ["resize-window", "-t", sessionName, "-x", String(cols), "-y", String(rows)])
  }

  async clear(sessionName: string): Promise<void> {
    await this.tmux("clear", [
      "send-keys",
      "-R",
      "-t",
      sessionName,
      ";",
      "clear-history",
      "-t",
      sessionName,
      ";",
      "send-keys",
      "-t",
      sessionName,
      "C-l",
    ])
  }

  async stop(sessionName: string): Promise<void> {
    const result = await this.run("tmux", ["kill-session", "-t", sessionName])
    if (result.code !== 0 && !/can't find session|no server running/i.test(result.stderr)) {
      throw commandError("stop", result)
    }
  }
}
