/**
 * Contents-API backend: durable job state in tracked repo files.
 *
 * One file per job at `<jobsDir>/<slug>.state.json`. Reads and
 * writes go through the GitHub Contents API, so the default GITHUB_TOKEN
 * (with `contents: write`) is sufficient — no PAT or `gist` scope.
 *
 * Each `save` that produces a real change creates a commit on the dedicated
 * `kody-state` branch (see ../../stateBranch), NOT the default branch — that
 * keeps this high-churn bookkeeping out of the code history. To further avoid
 * churn on idle ticks, writes are skipped when the next state is structurally
 * identical to the prior state (`isStateUnchanged`).
 *
 * No `hydrate`/`persist` lifecycle — state is always live in the repo.
 */

import { gh } from "../../issue.js"
import { STATE_BRANCH, ensureStateBranch } from "../../stateBranch.js"
import { initialStateEnvelope, isStateEnvelope, type StateEnvelope } from "../issueStateComment.js"
import {
  isStateUnchanged,
  type LoadedJobState,
  type JobStateBackend,
  slugFromStateFilePath,
  stateFilePath,
} from "./backend.js"

interface ContentsResponse {
  type: string
  encoding: string
  content: string
  sha: string
  path: string
}

export interface ContentsApiBackendOptions {
  owner: string
  repo: string
  jobsDir: string
  cwd?: string
}

export class ContentsApiBackend implements JobStateBackend {
  readonly name = "contents-api"

  private readonly owner: string
  private readonly repo: string
  private readonly jobsDir: string
  private readonly cwd?: string

  constructor(opts: ContentsApiBackendOptions) {
    if (!opts.owner || !opts.repo) {
      throw new Error("ContentsApiBackend: owner and repo are required")
    }
    this.owner = opts.owner
    this.repo = opts.repo
    this.jobsDir = opts.jobsDir
    this.cwd = opts.cwd
  }

  load(slug: string): LoadedJobState {
    const filePath = stateFilePath(this.jobsDir, slug)
    let raw = ""
    try {
      raw = gh(["api", `/repos/${this.owner}/${this.repo}/contents/${filePath}?ref=${STATE_BRANCH}`], {
        cwd: this.cwd,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 404 = file doesn't exist yet (first run). Anything else is a real error.
      if (/HTTP 404/i.test(msg) || /Not Found/i.test(msg)) {
        return { path: filePath, handle: null, state: initialStateEnvelope("seed"), created: true }
      }
      throw err
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`ContentsApiBackend: contents API for ${filePath} did not return JSON`)
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`ContentsApiBackend: contents API for ${filePath} returned non-object`)
    }
    const o = parsed as ContentsResponse
    if (o.type !== "file" || o.encoding !== "base64" || typeof o.content !== "string") {
      throw new Error(`ContentsApiBackend: ${filePath} is not a base64 file`)
    }
    const decoded = Buffer.from(o.content, "base64").toString("utf-8")
    let envelope: unknown
    try {
      envelope = JSON.parse(decoded)
    } catch {
      throw new Error(`ContentsApiBackend: ${filePath} is not valid JSON`)
    }
    if (!isStateEnvelope(envelope)) {
      throw new Error(`ContentsApiBackend: ${filePath} is not a StateEnvelope`)
    }
    return { path: filePath, handle: o.sha, state: envelope, created: false }
  }

  save(loaded: LoadedJobState, next: StateEnvelope): boolean {
    // Idempotency: skip the commit when the agent's state is byte-identical
    // to what's already on disk. The rev still bumps client-side, but a
    // no-action tick means cursor and data are unchanged — don't write.
    if (!loaded.created && isStateUnchanged(loaded.state, next)) {
      return false
    }

    const slug = slugFromStateFilePath(loaded.path)
    const body = JSON.stringify(next, null, 2) + "\n"
    const payload: Record<string, unknown> = {
      message: `chore(jobs): update state for ${slug} (rev ${next.rev})`,
      content: Buffer.from(body, "utf-8").toString("base64"),
      // Commit to the dedicated state branch instead of the default branch.
      branch: STATE_BRANCH,
    }
    // `handle` is the prior blob SHA (set by `load` after a real read,
    // null when the file was newly seeded). Required for safe updates.
    if (typeof loaded.handle === "string") payload.sha = loaded.handle

    // The Contents API rejects a write to a branch that doesn't exist yet —
    // create `kody-state` on first use for this repo.
    ensureStateBranch(this.owner, this.repo, this.cwd)

    gh(["api", "--method", "PUT", `/repos/${this.owner}/${this.repo}/contents/${loaded.path}`, "--input", "-"], {
      cwd: this.cwd,
      input: JSON.stringify(payload),
    })
    return true
  }
}
