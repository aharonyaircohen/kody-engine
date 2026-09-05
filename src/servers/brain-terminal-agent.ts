import { mkdir } from "node:fs/promises"
import * as path from "node:path"
import { createInterface } from "node:readline"
import { defaultCloneRepo, ensureRepoCwd } from "../repoWorkspace.js"
import { FileBrainTerminalMetadataStore, TmuxBrainTerminalRuntime } from "../terminal/brain-terminal-adapters.js"
import {
  type BrainTerminalEvent,
  BrainTerminalSessionAgent,
  parseBrainTerminalCommand,
  parseBrainTerminalOpenRequest,
  parseBrainTerminalStatusRequest,
} from "../terminal/brain-terminal-session.js"

const DEFAULT_POLL_INTERVAL_MS = 50

function writeEvent(output: NodeJS.WritableStream, event: BrainTerminalEvent): void {
  output.write(`${JSON.stringify(event)}\n`)
}

export async function brainTerminalAgent(options: {
  cwd: string
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  error?: NodeJS.WritableStream
  pollIntervalMs?: number
}): Promise<number> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const error = options.error ?? process.stderr
  const reposRoot = process.env.BRAIN_REPOS_ROOT?.trim() || path.join(path.dirname(path.resolve(options.cwd)), "repos")
  const stateRoot =
    process.env.BRAIN_TERMINAL_STATE_ROOT?.trim() || path.join(path.dirname(reposRoot), ".kody", "terminal-sessions")
  const agent = new BrainTerminalSessionAgent({
    store: new FileBrainTerminalMetadataStore(stateRoot),
    runtime: new TmuxBrainTerminalRuntime(),
  })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let opened = false
  let poll: ReturnType<typeof setInterval> | null = null
  let pollRunning = false

  const stopPoll = () => {
    if (poll) clearInterval(poll)
    poll = null
  }

  const capture = async () => {
    if (pollRunning) return
    pollRunning = true
    try {
      const event = await agent.captureOutput()
      if (event) writeEvent(output, event)
      const status = await agent.status()
      if (status.state === "exited") {
        writeEvent(output, {
          type: "exited",
          sessionId: status.id,
          generation: status.generation,
        })
        stopPoll()
      }
    } catch (cause) {
      error.write(`[brain-terminal-agent] capture failed: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    } finally {
      pollRunning = false
    }
  }

  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      const value: unknown = JSON.parse(line)
      if (!opened) {
        if (value && typeof value === "object" && (value as { type?: unknown }).type === "status") {
          const request = parseBrainTerminalStatusRequest(value)
          const status = await agent.inspectStored(request.sessionId)
          if (status) {
            writeEvent(output, {
              type: "state",
              sessionId: status.id,
              generation: status.generation,
              state: status.state,
              processId: status.processId,
            })
          } else {
            writeEvent(output, {
              type: "failed",
              sessionId: request.sessionId,
              generation: 1,
              code: "session_not_found",
              message: "Terminal session not found",
            })
          }
          return 0
        }
        const requested = parseBrainTerminalOpenRequest(value)
        const repo = `${requested.session.scope.owner}/${requested.session.scope.repo}`
        const workspaceCwd =
          requested.workspace === "machine"
            ? path.resolve(options.cwd)
            : await ensureRepoCwd({
                baseCwd: options.cwd,
                reposRoot,
                repo,
                repoToken:
                  process.env.KODY_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_PAT,
                cloneRepo: defaultCloneRepo,
              })
        if (requested.workspace === "machine") await mkdir(workspaceCwd, { recursive: true })
        const events = await agent.open({ ...requested, cwd: workspaceCwd })
        for (const event of events) writeEvent(output, event)
        opened = true
        poll = setInterval(() => void capture(), options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
        poll.unref?.()
        continue
      }

      const command = parseBrainTerminalCommand(value)
      const event = await agent.command(command)
      if (event) writeEvent(output, event)
      if (command.type === "detach") stopPoll()
    }
    if (opened) await agent.detach()
    return 0
  } catch (cause) {
    stopPoll()
    error.write(`[brain-terminal-agent] ${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 1
  } finally {
    stopPoll()
    lines.close()
  }
}
