/**
 * Lifecycle registry — maps `profile.lifecycle` names to expanders.
 *
 * An expander mutates a Profile in place: it reads `profile.lifecycle` +
 * `profile.lifecycleConfig`, validates the config, and wraps the profile's
 * existing `scripts.preflight` / `scripts.postflight` with canonical
 * bookends. The result is what the executor sees — the executor never reads
 * `lifecycle` itself (keeps invariant 1 intact).
 *
 * Lifecycles exist to consolidate orchestration boilerplate (label, context
 * loading, verify, commit, comment) that recurs across many executables.
 * Per-executable specifics still go in `scripts.preflight` and
 * `scripts.postflight` — the lifecycle wraps them, it doesn't replace them.
 *
 * Adding a new lifecycle: create `src/lifecycles/<name>.ts`, export a
 * `LifecycleExpander`, register it below. Unknown values are rejected at
 * load time by `applyLifecycle`.
 */

import type { Profile } from "../executables/types.js"
import { ProfileError } from "../profile-error.js"
import { prBranchLifecycle } from "./prBranch.js"

export type LifecycleExpander = (profile: Profile, profilePath: string) => void

const REGISTRY: Record<string, LifecycleExpander> = {
  "pr-branch": prBranchLifecycle,
}

export function applyLifecycle(profile: Profile, profilePath: string): void {
  if (!profile.lifecycle) return
  const expander = REGISTRY[profile.lifecycle]
  if (!expander) {
    throw new ProfileError(
      profilePath,
      `unknown "lifecycle": "${profile.lifecycle}". Registered: ${Object.keys(REGISTRY).sort().join(", ")}`,
    )
  }
  expander(profile, profilePath)
}

export function registeredLifecycles(): string[] {
  return Object.keys(REGISTRY).sort()
}
