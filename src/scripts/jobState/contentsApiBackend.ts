/**
 * Contents-API backend: durable job state in the configured Kody state repo.
 *
 * One file per capability at:
 *
 *   <statePath>/<jobsDir without .kody>/<slug>/state.json
 *
 * The consumer repo no longer needs a `.kody` runtime tree or `kody-state`
 * branch for this state.
 */
import { readStateText, resolveStateRepoConfig, type StateRepoConfig, writeStateText } from "../../stateRepo.js"
import { initialStateEnvelope, isStateEnvelope, type StateEnvelope } from "../issueStateComment.js"
import {
  isStateUnchanged,
  type JobStateBackend,
  type LoadedJobState,
  slugFromStateFilePath,
  stateFilePath,
} from "./backend.js"

export interface ContentsApiBackendOptions {
  config: StateRepoConfig
  jobsDir: string
  cwd?: string
}

function stateRepoJobsDir(jobsDir: string): string {
  return jobsDir.replace(/^\.kody\/?/, "").replace(/\/+$/, "")
}

export class ContentsApiBackend implements JobStateBackend {
  readonly name = "contents-api"
  private readonly config: StateRepoConfig
  private readonly jobsDir: string
  private readonly cwd?: string

  constructor(opts: ContentsApiBackendOptions) {
    resolveStateRepoConfig(opts.config)
    this.config = opts.config
    this.jobsDir = stateRepoJobsDir(opts.jobsDir)
    this.cwd = opts.cwd
  }

  load(slug: string): LoadedJobState {
    const filePath = stateFilePath(this.jobsDir, slug)
    const loaded = readStateText(this.config, this.cwd, filePath)
    if (!loaded) {
      return { path: filePath, handle: null, state: initialStateEnvelope("seed"), created: true }
    }

    let envelope: unknown
    try {
      envelope = JSON.parse(loaded.content)
    } catch {
      throw new Error(`ContentsApiBackend: ${filePath} is not valid JSON`)
    }
    if (!isStateEnvelope(envelope)) {
      throw new Error(`ContentsApiBackend: ${filePath} is not a StateEnvelope`)
    }
    return { path: filePath, handle: loaded.sha, state: envelope, created: false }
  }

  save(loaded: LoadedJobState, next: StateEnvelope): boolean {
    if (!loaded.created && isStateUnchanged(loaded.state, next)) {
      return false
    }

    const slug = slugFromStateFilePath(loaded.path)
    const body = `${JSON.stringify(next, null, 2)}\n`
    const message = `chore(jobs): update state for ${slug} (rev ${next.rev})`
    const sha = typeof loaded.handle === "string" ? loaded.handle : undefined

    try {
      writeStateText(this.config, this.cwd, loaded.path, body, message, sha)
    } catch (err) {
      if (!isShaConflict(err)) throw err
      const current = this.load(slug)
      if (!current.created && isStateUnchanged(current.state, next)) return false
      const currentSha = typeof current.handle === "string" ? current.handle : undefined
      process.stderr.write(
        `[kody] jobState: concurrent write detected for ${slug}; reloaded SHA and retrying (last-write-wins)\n`,
      )
      writeStateText(this.config, this.cwd, loaded.path, body, message, currentSha)
    }
    return true
  }
}

/** True when Contents-API PUT failed because prior blob SHA was stale. */
function isShaConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /HTTP 409/i.test(msg) || /HTTP 422/i.test(msg) || /does not match|is at|but expected/i.test(msg)
}
