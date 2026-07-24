import * as fs from "node:fs"
import * as path from "node:path"
import { definitionsRoot } from "./definition-paths.js"

export type LoopTrigger =
  | { type: "manual" }
  | { type: "schedule"; every: string; at?: { time: string; timezone: string } }
  | { type: "event"; event: string }
  | { type: "webhook"; event: string }
  | { type: "condition"; expression: string }

export interface LoopDefinition {
  id: string
  trigger: LoopTrigger
  target: { kind: "workflow" | "capability"; id: string }
  input: Record<string, unknown>
  enabled: boolean
}

const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/

export function normalizeLoopDefinition(value: unknown): LoopDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => !["id", "trigger", "target", "input", "enabled"].includes(key))) return null
  if (typeof raw.id !== "string" || !ID.test(raw.id)) return null
  if (typeof raw.enabled !== "boolean") return null
  if (!isObject(raw.input) || !isObject(raw.trigger) || !isObject(raw.target)) return null
  const targetKind = raw.target.kind
  const targetId = raw.target.id
  if ((targetKind !== "workflow" && targetKind !== "capability") || typeof targetId !== "string" || !ID.test(targetId)) {
    return null
  }
  const trigger = normalizeTrigger(raw.trigger)
  if (!trigger) return null
  return {
    id: raw.id,
    trigger,
    target: { kind: targetKind, id: targetId },
    input: raw.input,
    enabled: raw.enabled,
  }
}

export function readLoopDefinition(cwd: string, id: string): LoopDefinition | null {
  if (!ID.test(id)) return null
  const roots = [
    path.join(cwd, ".kody-engine", "runtime"),
    definitionsRoot(cwd),
  ]
  for (const root of roots) {
    const filePath = path.join(root, "loops", id, "loop.json")
    if (!fs.existsSync(filePath)) continue
    try {
      const loop = normalizeLoopDefinition(JSON.parse(fs.readFileSync(filePath, "utf8")))
      if (loop?.id === id) return loop
    } catch {
    }
  }
  return null
}

function normalizeTrigger(raw: Record<string, unknown>): LoopTrigger | null {
  if (raw.type === "manual" && Object.keys(raw).length === 1) return { type: "manual" }
  if (raw.type === "schedule" && typeof raw.every === "string" && /^\d+[mhd]$/.test(raw.every)) {
    if (raw.at === undefined && Object.keys(raw).every((key) => key === "type" || key === "every")) {
      return { type: "schedule", every: raw.every }
    }
    if (
      isObject(raw.at) &&
      typeof raw.at.time === "string" &&
      typeof raw.at.timezone === "string" &&
      Object.keys(raw.at).every((key) => key === "time" || key === "timezone") &&
      Object.keys(raw).every((key) => key === "type" || key === "every" || key === "at")
    ) {
      return { type: "schedule", every: raw.every, at: { time: raw.at.time, timezone: raw.at.timezone } }
    }
  }
  if (
    (raw.type === "event" || raw.type === "webhook") &&
    typeof raw.event === "string" &&
    raw.event.trim() &&
    Object.keys(raw).every((key) => key === "type" || key === "event")
  ) {
    return { type: raw.type, event: raw.event.trim() }
  }
  if (
    raw.type === "condition" &&
    typeof raw.expression === "string" &&
    raw.expression.trim() &&
    Object.keys(raw).every((key) => key === "type" || key === "expression")
  ) {
    return { type: "condition", expression: raw.expression.trim() }
  }
  return null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
