/**
 * Job state backend resolver.
 *
 * The backend is the single durable runtime authority. LocalFileBackend is
 * available only as a directly constructed unit-test seam.
 */

import type { KodyConfig } from "../../config.js"
import type { JobStateBackend } from "./backend.js"
import { BackendStateBackend } from "./backendStateBackend.js"
import { LocalFileBackend } from "./localFileBackend.js"

export type JobStateBackendName = "backend"

export interface ResolveBackendOptions {
  config: KodyConfig
  cwd: string
  jobsDir: string
}

export function resolveBackend(opts: ResolveBackendOptions): JobStateBackend {
  // Unit tests exercise state transitions without a live backend. This seam is
  // deliberately unavailable in production, including GitHub Actions.
  if (process.env.VITEST === "true" && process.env.KODY_TEST_LOCAL_JOB_STATE === "1") {
    return new LocalFileBackend({
      cwd: opts.cwd,
      jobsDir: opts.jobsDir,
      owner: opts.config.github.owner,
      repo: opts.config.github.repo,
    })
  }
  return new BackendStateBackend({ config: opts.config, jobsDir: opts.jobsDir })
}

export type { JobStateBackend, LoadedJobState } from "./backend.js"
export { isStateUnchanged, slugFromStateFilePath, stateFilePath } from "./backend.js"
