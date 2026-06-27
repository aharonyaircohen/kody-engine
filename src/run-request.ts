export const RUN_REQUEST_ENV = "KODY_RUN_REQUEST_JSON"

export type RunTarget =
  | { type: "chat"; id: string }
  | { type: "goal"; id: string }
  | { type: "issue"; id: number }
  | { type: "workflow"; id: string }

export type RunIntent = "continue" | "manage" | "run" | "tick"
export type RunSource = "dashboard" | "github" | "schedule"

export interface RunRequest {
  target: RunTarget
  intent: RunIntent
  source: RunSource
  input?: Record<string, unknown>
}

export type RunRequestParseResult = { request: RunRequest } | { error: string }

const INTENTS = new Set<RunIntent>(["continue", "manage", "run", "tick"])
const SOURCES = new Set<RunSource>(["dashboard", "github", "schedule"])
const TARGET_TYPES = new Set<RunTarget["type"]>(["chat", "goal", "issue", "workflow"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function parseTarget(input: unknown): { target: RunTarget } | { error: string } {
  if (!isRecord(input)) return { error: "runRequest.target must be an object" }
  const type = readString(input.type) as RunTarget["type"]
  if (!TARGET_TYPES.has(type)) return { error: "runRequest.target.type is invalid" }

  if (type === "issue") {
    const id = Number(input.id)
    if (!Number.isInteger(id) || id <= 0) return { error: "runRequest.target.id must be a positive issue number" }
    return { target: { type, id } }
  }

  const id = readString(input.id)
  if (!id) return { error: "runRequest.target.id is required" }
  return { target: { type, id } }
}

export function parseRunRequest(input: unknown): RunRequestParseResult {
  let body = input
  if (typeof input === "string") {
    const raw = input.trim()
    if (!raw) return { error: `${RUN_REQUEST_ENV} is empty` }
    try {
      body = JSON.parse(raw)
    } catch {
      return { error: `${RUN_REQUEST_ENV} must be valid JSON` }
    }
  }

  if (!isRecord(body)) return { error: "runRequest must be an object" }
  const parsedTarget = parseTarget(body.target)
  if ("error" in parsedTarget) return parsedTarget

  const intent = readString(body.intent) as RunIntent
  if (!INTENTS.has(intent)) return { error: "runRequest.intent is invalid" }

  const source = readString(body.source) as RunSource
  if (!SOURCES.has(source)) return { error: "runRequest.source is invalid" }

  if (body.input !== undefined && !isRecord(body.input)) {
    return { error: "runRequest.input must be an object when provided" }
  }

  return {
    request: {
      target: parsedTarget.target,
      intent,
      source,
      ...(body.input !== undefined ? { input: body.input } : {}),
    },
  }
}

export function readRunRequestFromEnv(env: NodeJS.ProcessEnv = process.env): RunRequestParseResult | null {
  const raw = env[RUN_REQUEST_ENV]
  if (raw == null || raw.trim() === "") return null
  return parseRunRequest(raw)
}
