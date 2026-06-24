/** Small gh wrappers shared by non-goal scripts. */
import { gh } from "../issue.js"

export interface OperationResult<T = void> {
  ok: boolean
  /** Returned on success; undefined on failure. */
  value?: T
  /** First line of stderr or error message on failure. */
  error?: string
}

function fail(err: unknown): OperationResult<never> {
  if (err instanceof Error) {
    const lines = err.message.split("\n").filter(Boolean)
    return { ok: false, error: lines[0] ?? err.message }
  }
  return { ok: false, error: String(err) }
}

/** Comment on an issue or PR. */
export function commentOnIssue(issueNumber: number, body: string, cwd?: string): OperationResult {
  try {
    gh(["issue", "comment", String(issueNumber), "--body", body], { cwd })
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

/** Squash-merge PR and delete its branch. */
export function mergePrSquash(prNumber: number, cwd?: string): OperationResult {
  try {
    gh(["pr", "merge", String(prNumber), "--squash", "--delete-branch"], { cwd })
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}
