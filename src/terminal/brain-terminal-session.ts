import { createHash } from "node:crypto"

export type BrainTerminalSessionState = "starting" | "ready" | "detached" | "exited" | "failed"

export interface BrainTerminalScope {
  owner: string
  repo: string
  conversationId: string
}

export interface BrainTerminalOpenRequest {
  type: "open"
  session: { id: string; scope: BrainTerminalScope }
  cwd: string
  afterRevision?: number
  cols: number
  rows: number
}

export interface BrainTerminalStatusRequest {
  type: "status"
  sessionId: string
}

export type BrainTerminalCommand =
  | { type: "attach"; sessionId: string; afterRevision?: number }
  | { type: "input"; sessionId: string; inputId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "detach"; sessionId: string }
  | { type: "restart"; sessionId: string }

export type BrainTerminalEvent =
  | {
      type: "state"
      sessionId: string
      generation: number
      state: BrainTerminalSessionState
      processId?: number | null
    }
  | { type: "output"; sessionId: string; generation: number; revision: number; data: string }
  | { type: "input-accepted"; sessionId: string; generation: number; inputId: string }
  | { type: "exited"; sessionId: string; generation: number; code?: number }
  | { type: "failed"; sessionId: string; generation: number; code: string; message: string }

export interface StoredBrainTerminalSession {
  version: 1
  id: string
  scope: BrainTerminalScope
  sessionName: string
  cwd: string
  generation: number
  state: BrainTerminalSessionState
  revision: number
  output: string
  processId: number | null
  cols: number
  rows: number
  updatedAt: string
}

export interface BrainTerminalMetadataStore {
  read(id: string): Promise<StoredBrainTerminalSession | null>
  write(session: StoredBrainTerminalSession): Promise<void>
}

export interface BrainTerminalRuntime {
  start(sessionName: string, cwd: string, cols: number, rows: number): Promise<{ processId: number }>
  inspect(sessionName: string): Promise<{ alive: boolean; processId: number | null }>
  capture(sessionName: string): Promise<string>
  input(sessionName: string, data: string): Promise<void>
  resize(sessionName: string, cols: number, rows: number): Promise<void>
  stop(sessionName: string): Promise<void>
}

export interface BrainTerminalStatus {
  id: string
  generation: number
  state: BrainTerminalSessionState
  revision: number
  processId: number | null
}

const MAX_CAPTURE_CHARS = 200_000

function requiredIdentifier(value: unknown, name: string, max = 240): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters`)
  }
  return value.trim()
}

function terminalSize(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 1_000) {
    throw new Error(`${name} must be an integer between 1 and 1000`)
  }
  return Number(value)
}

function revision(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error("afterRevision must be a non-negative integer")
  }
  return Number(value)
}

export function parseBrainTerminalOpenRequest(value: unknown): BrainTerminalOpenRequest {
  if (!value || typeof value !== "object") throw new Error("open request must be an object")
  const request = value as Record<string, unknown>
  if (request.type !== "open") throw new Error("first terminal message must be open")
  if (!request.session || typeof request.session !== "object") throw new Error("session is required")
  const session = request.session as Record<string, unknown>
  if (!session.scope || typeof session.scope !== "object") throw new Error("session scope is required")
  const scope = session.scope as Record<string, unknown>
  return {
    type: "open",
    session: {
      id: requiredIdentifier(session.id, "session.id"),
      scope: {
        owner: requiredIdentifier(scope.owner, "scope.owner", 100),
        repo: requiredIdentifier(scope.repo, "scope.repo", 100),
        conversationId: requiredIdentifier(scope.conversationId, "scope.conversationId"),
      },
    },
    cwd: requiredIdentifier(request.cwd, "cwd", 1_000),
    afterRevision: revision(request.afterRevision),
    cols: terminalSize(request.cols, "cols"),
    rows: terminalSize(request.rows, "rows"),
  }
}

export function parseBrainTerminalStatusRequest(value: unknown): BrainTerminalStatusRequest {
  if (!value || typeof value !== "object") throw new Error("status request must be an object")
  const request = value as Record<string, unknown>
  if (request.type !== "status") throw new Error("terminal request must be status")
  return { type: "status", sessionId: requiredIdentifier(request.sessionId, "sessionId") }
}

export function parseBrainTerminalCommand(value: unknown): BrainTerminalCommand {
  if (!value || typeof value !== "object") throw new Error("terminal command must be an object")
  const command = value as Record<string, unknown>
  const sessionId = requiredIdentifier(command.sessionId, "sessionId")
  switch (command.type) {
    case "attach":
      return { type: "attach", sessionId, afterRevision: revision(command.afterRevision) }
    case "input": {
      const inputId = requiredIdentifier(command.inputId, "inputId")
      if (typeof command.data !== "string" || command.data.length === 0) {
        throw new Error("data must be a non-empty string")
      }
      return { type: "input", sessionId, inputId, data: command.data }
    }
    case "resize":
      return {
        type: "resize",
        sessionId,
        cols: terminalSize(command.cols, "cols"),
        rows: terminalSize(command.rows, "rows"),
      }
    case "detach":
      return { type: "detach", sessionId }
    case "restart":
      return { type: "restart", sessionId }
    default:
      throw new Error("unknown terminal command")
  }
}

function sessionName(id: string): string {
  return `kody_${createHash("sha256").update(id).digest("hex").slice(0, 32)}`
}

function stateEvent(session: StoredBrainTerminalSession): BrainTerminalEvent {
  return {
    type: "state",
    sessionId: session.id,
    generation: session.generation,
    state: session.state,
    processId: session.processId,
  }
}

function failedEvent(
  session: StoredBrainTerminalSession,
  code: string,
  cause: unknown,
): BrainTerminalEvent {
  return {
    type: "failed",
    sessionId: session.id,
    generation: session.generation,
    code,
    message: cause instanceof Error ? cause.message : String(cause),
  }
}

export class BrainTerminalSessionAgent {
  private session: StoredBrainTerminalSession | null = null

  constructor(
    private readonly dependencies: {
      store: BrainTerminalMetadataStore
      runtime: BrainTerminalRuntime
      now?: () => Date
    },
  ) {}

  private now(): string {
    return (this.dependencies.now?.() ?? new Date()).toISOString()
  }

  private requireSession(): StoredBrainTerminalSession {
    if (!this.session) throw new Error("terminal session is not open")
    return this.session
  }

  private async persist(session: StoredBrainTerminalSession): Promise<void> {
    this.session = session
    await this.dependencies.store.write(session)
  }

  async open(rawRequest: BrainTerminalOpenRequest): Promise<BrainTerminalEvent[]> {
    const request = parseBrainTerminalOpenRequest(rawRequest)
    let session = await this.dependencies.store.read(request.session.id)

    if (session &&
      (session.scope.owner !== request.session.scope.owner ||
        session.scope.repo !== request.session.scope.repo ||
        session.scope.conversationId !== request.session.scope.conversationId)) {
      throw new Error("terminal session scope does not match stored identity")
    }

    if (!session) {
      session = {
        version: 1,
        id: request.session.id,
        scope: request.session.scope,
        sessionName: sessionName(request.session.id),
        cwd: request.cwd,
        generation: 1,
        state: "starting",
        revision: 0,
        output: "",
        processId: null,
        cols: request.cols,
        rows: request.rows,
        updatedAt: this.now(),
      }
      await this.persist(session)
      let started: { processId: number }
      try {
        started = await this.dependencies.runtime.start(
          session.sessionName,
          session.cwd,
          session.cols,
          session.rows,
        )
      } catch (cause) {
        session = { ...session, state: "failed", updatedAt: this.now() }
        await this.persist(session)
        return [failedEvent(session, "runtime_start_failed", cause)]
      }
      session = { ...session, state: "ready", processId: started.processId, updatedAt: this.now() }
      await this.persist(session)
    } else {
      const runtime = await this.dependencies.runtime.inspect(session.sessionName)
      session = {
        ...session,
        state: runtime.alive ? "ready" : session.state === "failed" ? "failed" : "exited",
        processId: runtime.processId,
        cols: request.cols,
        rows: request.rows,
        updatedAt: this.now(),
      }
      if (runtime.alive) {
        await this.dependencies.runtime.resize(session.sessionName, request.cols, request.rows)
      }
      await this.persist(session)
    }

    const events: BrainTerminalEvent[] = [stateEvent(session)]
    if (
      session.output &&
      (request.afterRevision === undefined || request.afterRevision < session.revision)
    ) {
      events.push({
        type: "output",
        sessionId: session.id,
        generation: session.generation,
        revision: session.revision,
        data: `\u001b[2J\u001b[H${session.output}`,
      })
    }
    return events
  }

  async inspectStored(sessionId: string): Promise<BrainTerminalStatus | null> {
    const id = requiredIdentifier(sessionId, "sessionId")
    const session = await this.dependencies.store.read(id)
    if (!session) return null
    const runtime = await this.dependencies.runtime.inspect(session.sessionName)
    const next = {
      ...session,
      state: runtime.alive ? session.state : ("exited" as const),
      processId: runtime.processId,
      updatedAt: this.now(),
    }
    await this.persist(next)
    return {
      id: next.id,
      generation: next.generation,
      state: next.state,
      revision: next.revision,
      processId: next.processId,
    }
  }

  async status(): Promise<BrainTerminalStatus> {
    const session = this.requireSession()
    const runtime = await this.dependencies.runtime.inspect(session.sessionName)
    const nextState = runtime.alive
      ? session.state
      : session.state === "failed"
        ? "failed"
        : "exited"
    if (nextState !== session.state || runtime.processId !== session.processId) {
      await this.persist({
        ...session,
        state: nextState,
        processId: runtime.processId,
        updatedAt: this.now(),
      })
    }
    const current = this.requireSession()
    return {
      id: current.id,
      generation: current.generation,
      state: current.state,
      revision: current.revision,
      processId: current.processId,
    }
  }

  async captureOutput(): Promise<BrainTerminalEvent | null> {
    const session = this.requireSession()
    if (session.state !== "ready" && session.state !== "detached") return null
    const output = (await this.dependencies.runtime.capture(session.sessionName)).slice(-MAX_CAPTURE_CHARS)
    if (output === session.output) return null
    const next = {
      ...session,
      output,
      revision: session.revision + 1,
      updatedAt: this.now(),
    }
    await this.persist(next)
    return {
      type: "output",
      sessionId: next.id,
      generation: next.generation,
      revision: next.revision,
      data: `\u001b[2J\u001b[H${output}`,
    }
  }

  async detach(): Promise<BrainTerminalEvent> {
    const session = this.requireSession()
    const next = { ...session, state: "detached" as const, updatedAt: this.now() }
    await this.persist(next)
    return stateEvent(next)
  }

  async command(rawCommand: BrainTerminalCommand): Promise<BrainTerminalEvent | null> {
    const command = parseBrainTerminalCommand(rawCommand)
    const session = this.requireSession()
    if (command.sessionId !== session.id) throw new Error("terminal command session identity mismatch")

    switch (command.type) {
      case "attach":
        return stateEvent(session)
      case "input":
        if (session.state !== "ready") throw new Error(`input is not allowed while terminal is ${session.state}`)
        await this.dependencies.runtime.input(session.sessionName, command.data)
        return {
          type: "input-accepted",
          sessionId: session.id,
          generation: session.generation,
          inputId: command.inputId,
        }
      case "resize":
        if (session.state !== "ready") throw new Error(`resize is not allowed while terminal is ${session.state}`)
        await this.dependencies.runtime.resize(session.sessionName, command.cols, command.rows)
        await this.persist({ ...session, cols: command.cols, rows: command.rows, updatedAt: this.now() })
        return null
      case "detach":
        return this.detach()
      case "restart": {
        if (session.state === "starting") throw new Error("restart is not allowed while terminal is starting")
        await this.dependencies.runtime.stop(session.sessionName)
        const starting = {
          ...session,
          generation: session.generation + 1,
          state: "starting" as const,
          revision: 0,
          output: "",
          processId: null,
          updatedAt: this.now(),
        }
        await this.persist(starting)
        let started: { processId: number }
        try {
          started = await this.dependencies.runtime.start(
            starting.sessionName,
            starting.cwd,
            starting.cols,
            starting.rows,
          )
        } catch (cause) {
          const failed = { ...starting, state: "failed" as const, updatedAt: this.now() }
          await this.persist(failed)
          return failedEvent(failed, "runtime_start_failed", cause)
        }
        const ready = { ...starting, state: "ready" as const, processId: started.processId, updatedAt: this.now() }
        await this.persist(ready)
        return stateEvent(ready)
      }
    }
  }
}
