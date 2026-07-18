import { createStateBackendFromEnv } from "./state-backend.js"

export const TRUST_FILE_PATH = "state/trust.json"

export type TrustMode = "ask" | "auto"
export type TrustSubjectKind = "capability" | "goal" | "loop" | "workflow"
export type TrustModeOverride = TrustMode | null

export interface TrustSubject {
  kind: TrustSubjectKind
  id: string
}

export function trustSubjectKey(subject: TrustSubject): string {
  return `${subject.kind}:${subject.id}`
}

export function parseTrustMode(rawJson: string, subject: TrustSubject): TrustMode {
  return parseTrustModeOverride(rawJson, subject) ?? "ask"
}

export function parseTrustModeOverride(rawJson: string, subject: TrustSubject): TrustModeOverride {
  const key = trustSubjectKey(subject)
  try {
    const parsed = JSON.parse(rawJson) as {
      capabilities?: Record<string, { mode?: string; neverAuto?: boolean }>
      subjects?: Record<string, { mode?: string; neverAuto?: boolean }>
    }
    const entry = subject.kind === "capability" ? parsed?.capabilities?.[subject.id] : parsed?.subjects?.[key]
    // neverAuto pins the subject to approval-required regardless of earned mode.
    if (entry?.neverAuto === true) return "ask"
    const rawMode = entry?.mode
    if (rawMode === "auto" || rawMode === "ask") return rawMode
    return null
  } catch {
    return null
  }
}

export async function readTrustModeOverrideAsync(repoSlug: string, subject: TrustSubject): Promise<TrustModeOverride> {
  if (!subject.id) return null
  if (!/^[^/\s]+\/[^/\s]+$/.test(repoSlug)) throw new Error("Repository identity is required for trust policy")
  const stored = await createStateBackendFromEnv().getManifest(repoSlug, "capability-trust")
  return stored ? parseTrustModeOverride(JSON.stringify(stored.doc), subject) : null
}
