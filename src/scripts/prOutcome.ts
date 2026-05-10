/**
 * Typed outcome of the `ensurePr` postflight. Discriminated union — every
 * downstream consumer must handle all four cases. There is no "default" /
 * "fallthrough" path that could template undefined into a success message.
 *
 * Producer: scripts/ensurePr.ts (always sets ctx.data.prResult to one of these).
 * Consumer: scripts/postIssueComment.ts (switches exhaustively on `kind`).
 *
 * Architectural intent — see CLAUDE.md "no silent skips" / "fail closed":
 *   - Every conditional skip carries a `reason`, observable to consumers.
 *   - Crashes surface with the underlying message; we never pretend success.
 *   - "PR opened" can only be emitted from `Created` where `url` is required.
 */

export interface PrCreated {
  kind: "created"
  url: string
  number: number
  draft: boolean
}

export interface PrUpdated {
  kind: "updated"
  url: string
  number: number
  draft: boolean
}

export interface PrSkipped {
  kind: "skipped"
  /**
   * Human-readable reason ensurePr did not run. Surfaces to the issue comment
   * so the user can tell the difference between "no work to ship" and
   * "preflight gated us out before we got here."
   */
  reason: string
}

export interface PrCrashed {
  kind: "crashed"
  /** Error message from the failed `gh pr create` / `gh pr edit` call. */
  reason: string
}

export type PrOutcome = PrCreated | PrUpdated | PrSkipped | PrCrashed

/**
 * Typed reader. Returns null when nothing has populated `ctx.data.prResult`
 * yet — usually means ensurePr never ran (e.g., the executor short-circuited
 * before postflights). Callers that absolutely require an outcome should
 * treat null as a logic error, not as "skipped."
 */
export function readPrOutcome(data: Record<string, unknown>): PrOutcome | null {
  const raw = data.prResult
  if (!raw || typeof raw !== "object") return null
  const r = raw as { kind?: string }
  switch (r.kind) {
    case "created":
    case "updated":
    case "skipped":
    case "crashed":
      return raw as PrOutcome
    default:
      return null
  }
}
