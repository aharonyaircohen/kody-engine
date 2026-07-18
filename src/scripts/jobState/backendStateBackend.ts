import type { KodyConfig } from "../../config.js"
import { createStateBackendFromEnv } from "../../state-backend.js"
import { initialStateEnvelope, isStateEnvelope, type StateEnvelope } from "../issueStateComment.js"
import { isStateUnchanged, type JobStateBackend, type LoadedJobState, stateFilePath } from "./backend.js"

export interface BackendStateBackendOptions {
  config: KodyConfig
  jobsDir: string
}

export class BackendStateBackend implements JobStateBackend {
  readonly name = "backend"
  private readonly tenantId: string
  private readonly jobsDir: string

  constructor(opts: BackendStateBackendOptions) {
    const owner = opts.config.github?.owner?.trim()
    const repo = opts.config.github?.repo?.trim()
    if (!owner || !repo) {
      throw new Error("BackendStateBackend requires config.github.owner and config.github.repo")
    }
    this.tenantId = `${owner}/${repo}`
    this.jobsDir = opts.jobsDir.replace(/\/+$/, "")
  }

  async load(slug: string): Promise<LoadedJobState> {
    const path = stateFilePath(this.jobsDir, slug)
    const loaded = await createStateBackendFromEnv().get(this.tenantId, `capabilities/${slug}`, "job-state")
    if (!loaded) {
      return { path, handle: null, state: initialStateEnvelope("seed"), created: true }
    }
    if (!isStateEnvelope(loaded.doc)) {
      throw new Error(`BackendStateBackend: capabilities/${slug} is not a StateEnvelope`)
    }
    return { path, handle: loaded.updatedAt, state: loaded.doc, created: false }
  }

  async save(loaded: LoadedJobState, next: StateEnvelope): Promise<boolean> {
    if (!loaded.created && isStateUnchanged(loaded.state, next)) return false
    const slug = loaded.path.split("/").at(-2)
    if (!slug) throw new Error(`BackendStateBackend: invalid state path ${loaded.path}`)
    await createStateBackendFromEnv().save(
      this.tenantId,
      `capabilities/${slug}`,
      "job-state",
      next,
      typeof loaded.handle === "string" ? loaded.handle : undefined,
    )
    return true
  }
}
