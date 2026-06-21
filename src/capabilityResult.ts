import type {
  ActResult,
  CapabilityAlert,
  CapabilityEvidenceItem,
  CapabilityKind,
  CapabilityResourceRef,
  CapabilityResult,
  CapabilitySuggestedAction,
  ObserveResult,
  VerifyResult,
} from "./executables/types.js"

const ACT_STATUSES = new Set(["created", "changed", "triggered", "skipped", "failed"])
const ALERT_LEVELS = new Set(["info", "warning", "error"])

export class CapabilityResultError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CapabilityResultError"
  }
}

export function parseCapabilityResult(raw: unknown, expectedKind?: CapabilityKind): CapabilityResult {
  const obj = asRecord(raw, "capability result")
  const kind = obj.kind
  if (kind !== "observe" && kind !== "act" && kind !== "verify") {
    throw new CapabilityResultError('"kind" must be one of: observe | act | verify')
  }
  if (expectedKind && kind !== expectedKind) {
    throw new CapabilityResultError(`capability result kind mismatch: expected ${expectedKind}, got ${kind}`)
  }
  if (kind === "observe") return parseObserveResult(obj)
  if (kind === "act") return parseActResult(obj)
  return parseVerifyResult(obj)
}

function parseObserveResult(obj: Record<string, unknown>): ObserveResult {
  const result: ObserveResult = { kind: "observe" }
  const facts = optionalRecord(obj.facts, "facts")
  const evidence = optionalRecord(obj.evidence, "evidence")
  const alerts = optionalArray(obj.alerts, "alerts", parseAlert)
  const suggestedActions = optionalArray(obj.suggestedActions, "suggestedActions", parseSuggestedAction)
  if (facts) result.facts = facts
  if (evidence) result.evidence = evidence
  if (alerts) result.alerts = alerts
  if (suggestedActions) result.suggestedActions = suggestedActions
  if (!facts && !evidence && !alerts && !suggestedActions) {
    throw new CapabilityResultError("observe result must include facts, alerts, suggestedActions, or evidence")
  }
  return result
}

function parseActResult(obj: Record<string, unknown>): ActResult {
  if (typeof obj.status !== "string" || !ACT_STATUSES.has(obj.status)) {
    throw new CapabilityResultError('"status" must be one of: created | changed | triggered | skipped | failed')
  }
  const result: ActResult = { kind: "act", status: obj.status as ActResult["status"] }
  const changedResources = optionalArray(obj.changedResources, "changedResources", parseResourceRef)
  const createdResources = optionalArray(obj.createdResources, "createdResources", parseResourceRef)
  const actionResult = optionalRecord(obj.actionResult, "actionResult")
  const evidence = optionalRecord(obj.evidence, "evidence")
  if (changedResources) result.changedResources = changedResources
  if (createdResources) result.createdResources = createdResources
  if (actionResult) result.actionResult = actionResult
  if (evidence) result.evidence = evidence
  return result
}

function parseVerifyResult(obj: Record<string, unknown>): VerifyResult {
  if (typeof obj.passed !== "boolean") {
    throw new CapabilityResultError('"passed" must be boolean')
  }
  const result: VerifyResult = { kind: "verify", passed: obj.passed }
  const evidence = optionalArray(obj.evidence, "evidence", parseEvidenceItem)
  const blockers = optionalStringArray(obj.blockers, "blockers")
  const facts = optionalRecord(obj.facts, "facts")
  if (evidence) result.evidence = evidence
  if (blockers) result.blockers = blockers
  if (facts) result.facts = facts
  return result
}

function parseAlert(raw: unknown, path: string): CapabilityAlert {
  const obj = asRecord(raw, path)
  if (obj.level !== undefined && (typeof obj.level !== "string" || !ALERT_LEVELS.has(obj.level))) {
    throw new CapabilityResultError(`${path}.level must be one of: info | warning | error`)
  }
  return {
    ...(obj.level ? { level: obj.level as CapabilityAlert["level"] } : {}),
    message: requiredString(obj.message, `${path}.message`),
  }
}

function parseSuggestedAction(raw: unknown, path: string): CapabilitySuggestedAction {
  const obj = asRecord(raw, path)
  const args = optionalRecord(obj.args, `${path}.args`)
  return {
    action: requiredString(obj.action, `${path}.action`),
    ...(args ? { args } : {}),
    ...(obj.reason !== undefined ? { reason: requiredString(obj.reason, `${path}.reason`) } : {}),
  }
}

function parseResourceRef(raw: unknown, path: string): CapabilityResourceRef {
  const obj = asRecord(raw, path)
  const ref: CapabilityResourceRef = { type: requiredString(obj.type, `${path}.type`) }
  if (obj.id !== undefined) {
    if (typeof obj.id !== "string" && typeof obj.id !== "number") {
      throw new CapabilityResultError(`${path}.id must be string or number`)
    }
    ref.id = obj.id
  }
  if (obj.number !== undefined) {
    if (typeof obj.number !== "number") throw new CapabilityResultError(`${path}.number must be number`)
    ref.number = obj.number
  }
  if (obj.url !== undefined) ref.url = requiredString(obj.url, `${path}.url`)
  if (obj.name !== undefined) ref.name = requiredString(obj.name, `${path}.name`)
  return ref
}

function parseEvidenceItem(raw: unknown, path: string): CapabilityEvidenceItem {
  const obj = asRecord(raw, path)
  return {
    ...(obj.source !== undefined ? { source: requiredString(obj.source, `${path}.source`) } : {}),
    message: requiredString(obj.message, `${path}.message`),
    ...(obj.url !== undefined ? { url: requiredString(obj.url, `${path}.url`) } : {}),
  }
}

function optionalArray<T>(
  raw: unknown,
  path: string,
  parseItem: (raw: unknown, path: string) => T,
): T[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new CapabilityResultError(`${path} must be an array`)
  return raw.map((item, index) => parseItem(item, `${path}[${index}]`))
}

function optionalStringArray(raw: unknown, path: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new CapabilityResultError(`${path} must be an array`)
  return raw.map((item, index) => requiredString(item, `${path}[${index}]`))
}

function optionalRecord(raw: unknown, path: string): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined
  return asRecord(raw, path)
}

function asRecord(raw: unknown, path: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CapabilityResultError(`${path} must be an object`)
  }
  return raw as Record<string, unknown>
}

function requiredString(raw: unknown, path: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new CapabilityResultError(`${path} must be a non-empty string`)
  }
  return raw
}
