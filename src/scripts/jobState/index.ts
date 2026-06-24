/**
 * Job state backend resolver.
 *
 * Picks an implementation based on `config.jobs.stateBackend`:
 *   "contents-api" (default) — durable in tracked files via GitHub Contents API
 *   "local-file"             — on-disk files, snapshotted to GitHub Actions cache
 *
 * Adding a backend: implement `JobStateBackend`, drop the file in this
 * directory, register a case below. Job-tick scripts (loadJobFromFile,
 * writeJobStateFile) and the dispatcher only see the interface — no
 * change needed to add a new storage option.
 */

import type { KodyConfig } from "../../config.js"
import type { JobStateBackend } from "./backend.js"
import { ContentsApiBackend } from "./contentsApiBackend.js"
import { LocalFileBackend } from "./localFileBackend.js"

export type JobStateBackendName = "contents-api" | "local-file"

export interface ResolveBackendOptions {
  config: KodyConfig
  cwd: string
  jobsDir: string
}

export function resolveBackend(opts: ResolveBackendOptions): JobStateBackend {
  const requested = opts.config.jobs?.stateBackend ?? "contents-api"

  switch (requested) {
    case "contents-api":
      return new ContentsApiBackend({ config: opts.config, jobsDir: opts.jobsDir, cwd: opts.cwd })
    case "local-file": {
      const owner = opts.config.github?.owner
      const repo = opts.config.github?.repo
      if (!owner || !repo) {
        throw new Error("resolveBackend: config.github.owner and config.github.repo must be set")
      }
      return new LocalFileBackend({ cwd: opts.cwd, jobsDir: opts.jobsDir, owner, repo })
    }
    default: {
      // Exhaustiveness check — TS will catch unhandled cases at compile time.
      const _exhaustive: never = requested
      throw new Error(`resolveBackend: unknown stateBackend "${String(_exhaustive)}"`)
    }
  }
}

export type { JobStateBackend, LoadedJobState } from "./backend.js"
export { isStateUnchanged, slugFromStateFilePath, stateFilePath } from "./backend.js"
