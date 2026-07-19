/**
 * Codex app-server Brain driver.
 *
 * This is deliberately behind the existing Brain chat protocol: Brain owns
 * the HTTP session and repository workspace, while Codex owns model calls and
 * local tools through the user's existing ChatGPT login.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { createInterface } from "node:readline"
import type { ChatTurnOptions, ChatTurnResult } from "./loop.js"
import type { ChatTurn } from "./session.js"
import type { SessionStore } from "./session-store.js"

type JsonRecord = Record<string, unknown>

export interface CodexNotification {
  method: string
  params?: JsonRecord
}

export interface CodexBrainEvent {
  type: "text" | "tool_use" | "done" | "error"
  chatId: string
  text?: string
  name?: string
  input?: unknown
  error?: string
}

export function codexThreadStartParams(args: { cwd: string; developerInstructions: string }): JsonRecord {
  return {
    cwd: args.cwd,
    developerInstructions: args.developerInstructions,
  }
}

export function codexTurnStartParams(args: { threadId: string; message: string }): JsonRecord {
  return {
    threadId: args.threadId,
    input: [{ type: "text", text: args.message }],
  }
}

export function translateCodexNotification(notification: CodexNotification, chatId: string): CodexBrainEvent[] {
  const params = notification.params ?? {}
  if (notification.method === "item/agentMessage/delta") {
    const delta = params.delta
    return typeof delta === "string" && delta.length > 0 ? [{ type: "text", text: delta, chatId }] : []
  }
  if (notification.method === "turn/completed") {
    return [{ type: "done", chatId }]
  }
  if (notification.method === "error") {
    const message = params.message
    return [
      {
        type: "error",
        error: typeof message === "string" ? message : "Codex app-server error",
        chatId,
      },
    ]
  }
  if (notification.method === "item/started") {
    const item = params.item
    if (!item || typeof item !== "object") return []
    const record = item as JsonRecord
    return [
      {
        type: "tool_use",
        name: typeof record.type === "string" ? record.type : "tool",
        input: record,
        chatId,
      },
    ]
  }
  return []
}

interface PendingRequest {
  resolve: (value: JsonRecord) => void
  reject: (error: Error) => void
}

interface TurnWaiter {
  resolve: () => void
  reject: (error: Error) => void
  onNotification: (notification: CodexNotification) => Promise<void> | void
  queue: Promise<void>
}

interface CodexProcess {
  child: ChildProcessWithoutNullStreams
  nextId: number
  pending: Map<number, PendingRequest>
  turnWaiters: Map<string, TurnWaiter>
}

export interface CodexAppServerClientOptions {
  cwd: string
  spawnImpl?: typeof spawn
}

/** A small JSONL client for one local `codex app-server` process. */
export class CodexAppServerClient {
  private readonly process: CodexProcess
  private initialized = false

  constructor(options: CodexAppServerClientOptions) {
    const child = (options.spawnImpl ?? spawn)("codex", ["app-server", "--stdio"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.process = {
      child,
      nextId: 1,
      pending: new Map(),
      turnWaiters: new Map(),
    }
    const lines = createInterface({ input: child.stdout })
    lines.on("line", (line) => this.handleLine(line))
    child.on("error", (error) => this.fail(error))
    child.on("exit", (code, signal) => {
      this.fail(new Error(`codex app-server exited (${code ?? `signal ${signal}`})`))
    })
  }

  async startThread(args: { cwd: string; developerInstructions: string }): Promise<string> {
    await this.ensureInitialized()
    const result = await this.request("thread/start", codexThreadStartParams(args))
    const thread = result.thread
    if (!thread || typeof thread !== "object") {
      throw new Error("Codex app-server returned no thread")
    }
    const id = (thread as JsonRecord).id
    if (typeof id !== "string" || !id) throw new Error("Codex app-server returned an invalid thread id")
    return id
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.ensureInitialized()
    await this.request("thread/resume", { threadId })
  }

  async runTurn(args: {
    threadId: string
    message: string
    onNotification: (notification: CodexNotification) => void
  }): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.process.turnWaiters.set(args.threadId, {
        resolve,
        reject,
        onNotification: args.onNotification,
        queue: Promise.resolve(),
      })
      void this.request("turn/start", codexTurnStartParams(args)).catch((error: Error) => {
        this.process.turnWaiters.delete(args.threadId)
        reject(error)
      })
    })
  }

  close(): void {
    this.process.child.kill()
    this.fail(new Error("Codex app-server client closed"))
  }

  private request(method: string, params: JsonRecord): Promise<JsonRecord> {
    const id = this.process.nextId++
    return new Promise<JsonRecord>((resolve, reject) => {
      this.process.pending.set(id, { resolve, reject })
      this.process.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
    })
  }

  private notify(method: string, params: JsonRecord): void {
    this.process.child.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    await this.request("initialize", {
      clientInfo: { name: "kody-brain", version: "0.1.0" },
    })
    this.notify("initialized", {})
    this.initialized = true
  }

  private handleLine(line: string): void {
    let message: JsonRecord
    try {
      message = JSON.parse(line) as JsonRecord
    } catch {
      return
    }
    if (typeof message.id === "number") {
      const pending = this.process.pending.get(message.id)
      if (!pending) return
      this.process.pending.delete(message.id)
      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonRecord
        pending.reject(new Error(typeof error.message === "string" ? error.message : "Codex request failed"))
      } else {
        pending.resolve((message.result as JsonRecord | undefined) ?? {})
      }
      return
    }
    if (typeof message.method !== "string") return
    const notification: CodexNotification = {
      method: message.method,
      params: typeof message.params === "object" && message.params !== null ? (message.params as JsonRecord) : {},
    }
    const threadId = notification.params?.threadId
    if (typeof threadId !== "string") return
    const waiter = this.process.turnWaiters.get(threadId)
    if (!waiter) return
    waiter.queue = waiter.queue.then(() => waiter.onNotification(notification))
    if (notification.method === "turn/completed" || notification.method === "error") {
      this.process.turnWaiters.delete(threadId)
      void waiter.queue.then(() => {
        if (notification.method === "error") {
          waiter.reject(new Error(String(notification.params?.message ?? "Codex turn failed")))
        } else {
          waiter.resolve()
        }
      }, waiter.reject)
    }
  }

  private fail(error: Error): void {
    for (const pending of this.process.pending.values()) pending.reject(error)
    this.process.pending.clear()
    for (const waiter of this.process.turnWaiters.values()) waiter.reject(error)
    this.process.turnWaiters.clear()
  }
}

const clients = new Map<string, CodexAppServerClient>()

function threadMapPath(cwd: string): string {
  return path.join(cwd, ".kody-engine", "runtime", "codex-threads.json")
}

function readThreadMap(cwd: string): Record<string, string> {
  try {
    const value = JSON.parse(fs.readFileSync(threadMapPath(cwd), "utf8")) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    )
  } catch {
    return {}
  }
}

function writeThreadMap(cwd: string, map: Record<string, string>): void {
  const file = threadMapPath(cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`)
}

export async function runCodexChatTurn(args: {
  opts: ChatTurnOptions
  turns: ChatTurn[]
  systemPrompt: string
  store: SessionStore
}): Promise<ChatTurnResult> {
  const { opts, turns, systemPrompt, store } = args
  const last = turns.at(-1)
  if (!last || last.role !== "user") {
    const error = "last turn is not a user message"
    await opts.sink.emit({
      event: "chat.error",
      payload: { error },
      runId: opts.sessionId,
      emittedAt: new Date().toISOString(),
    })
    return { exitCode: 64, error }
  }

  const client = clients.get(opts.cwd) ?? new CodexAppServerClient({ cwd: opts.cwd })
  clients.set(opts.cwd, client)
  const map = readThreadMap(opts.cwd)
  let threadId: string | undefined = map[opts.sessionId]
  if (threadId) {
    try {
      await client.resumeThread(threadId)
    } catch {
      threadId = undefined
    }
  }
  threadId ??= await client.startThread({ cwd: opts.cwd, developerInstructions: systemPrompt })
  if (!map[opts.sessionId]) {
    map[opts.sessionId] = threadId
    writeThreadMap(opts.cwd, map)
  }

  const replyParts: string[] = []
  try {
    await client.runTurn({
      threadId,
      message: last.content,
      onNotification: async (notification) => {
        for (const event of translateCodexNotification(notification, opts.sessionId)) {
          if (event.type === "text" && event.text) {
            replyParts.push(event.text)
            await opts.sink.emit({
              event: "chat.message",
              payload: { sessionId: opts.sessionId, role: "assistant", content: event.text },
              runId: opts.sessionId,
              emittedAt: new Date().toISOString(),
            })
          } else if (event.type === "tool_use") {
            await opts.sink.emit({
              event: "chat.tool",
              payload: { phase: "use", name: event.name, input: event.input },
              runId: opts.sessionId,
              emittedAt: new Date().toISOString(),
            })
          }
        }
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await opts.sink.emit({
      event: "chat.error",
      payload: { error: message },
      runId: opts.sessionId,
      emittedAt: new Date().toISOString(),
    })
    return { exitCode: 99, error: message }
  }

  const reply = replyParts.join("").trim()
  if (!reply) {
    const error = "Codex completed without producing a reply"
    await opts.sink.emit({
      event: "chat.error",
      payload: { error },
      runId: opts.sessionId,
      emittedAt: new Date().toISOString(),
    })
    return { exitCode: 99, error }
  }
  await store.appendTurn({ role: "assistant", content: reply, timestamp: new Date().toISOString() })
  await opts.sink.emit({
    event: "chat.done",
    payload: { sessionId: opts.sessionId },
    runId: opts.sessionId,
    emittedAt: new Date().toISOString(),
  })
  return { exitCode: 0, reply }
}
