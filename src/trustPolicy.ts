import { readStateText, type StateRepoConfig } from "./stateRepo.js"
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
      capabilities?: Record<string, { mode?: string }>
      subjects?: Record<string, { mode?: string }>
    }
    const rawMode =
      subject.kind === "capability" ? parsed?.capabilities?.[subject.id]?.mode : parsed?.subjects?.[key]?.mode
    if (rawMode === "auto" || rawMode === "ask") return rawMode
    return null
  } catch {
    return null
  }
}

export function readTrustMode(repoSlug: string, subject?: TrustSubject): TrustMode
export function readTrustMode(
  state: StateRepoConfig["state"] | undefined,
  repoSlug: string,
  subject?: TrustSubject,
): TrustMode
export function readTrustMode(
  stateOrRepoSlug: StateRepoConfig["state"] | string | undefined,
  repoSlugOrSubject?: string | TrustSubject,
  maybeSubject?: TrustSubject,
): TrustMode {
  const mode =
    typeof stateOrRepoSlug === "string"
      ? readTrustModeOverride(stateOrRepoSlug, repoSlugOrSubject as TrustSubject | undefined)
      : readTrustModeOverride(stateOrRepoSlug, repoSlugOrSubject as string, maybeSubject)
  return mode ?? "ask"
}

export function readTrustModeOverride(repoSlug: string, subject?: TrustSubject): TrustModeOverride
export function readTrustModeOverride(
  state: StateRepoConfig["state"] | undefined,
  repoSlug: string,
  subject?: TrustSubject,
): TrustModeOverride
export function readTrustModeOverride(
  stateOrRepoSlug: StateRepoConfig["state"] | string | undefined,
  repoSlugOrSubject?: string | TrustSubject,
  maybeSubject?: TrustSubject,
): TrustModeOverride {
  const state = typeof stateOrRepoSlug === "string" ? undefined : stateOrRepoSlug
  const repoSlug =
    typeof stateOrRepoSlug === "string"
      ? stateOrRepoSlug
      : typeof repoSlugOrSubject === "string"
        ? repoSlugOrSubject
        : ""
  const subject = typeof stateOrRepoSlug === "string" ? (repoSlugOrSubject as TrustSubject | undefined) : maybeSubject
  if (!subject?.id) return null
  try {
    const loaded = readStateText({ state: state ?? defaultStateForRepoSlug(repoSlug) }, undefined, TRUST_FILE_PATH)
    return loaded ? parseTrustModeOverride(loaded.content, subject) : null
  } catch {
    return null
  }
}

export async function readTrustModeOverrideAsync(
  repoSlug: string,
  subject: TrustSubject,
  state?: StateRepoConfig["state"],
): Promise<TrustModeOverride> {
  if (!subject.id) return null
  const backendConfigured = Boolean(
    process.env.CONVEX_URL?.trim() &&
    process.env.KODY_SERVICE_KEY?.trim() &&
    /^[^/\s]+\/[^/\s]+$/.test(repoSlug),
  )
  if (backendConfigured) {
    const stored = await createStateBackendFromEnv().getManifest(repoSlug, "capability-trust")
    return stored ? parseTrustModeOverride(JSON.stringify(stored.doc), subject) : null
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error("Convex backend is required for trust policy in GitHub Actions")
  }
  return readTrustModeOverride(state, repoSlug, subject)
}

function defaultStateForRepoSlug(repoSlug: string): StateRepoConfig["state"] {
  const [owner, repo] = repoSlug.split("/")
  return { repo: `${owner}/kody-state`, path: repo ?? repoSlug }
}
