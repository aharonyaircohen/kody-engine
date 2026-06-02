/**
 * Local-file backend: job state lives as plain files on disk under
 * `<cwd>/<jobsDir>/<slug>.state.json`. No git involvement at all.
 *
 * Durability between workflow runs is provided by the `hydrate`/`persist`
 * lifecycle, which restores from / saves to the GitHub Actions cache when
 * running inside Actions. Off-CI, both lifecycle hooks are no-ops — the
 * directory is whatever's on disk (handy for local job development).
 *
 * Cache key format: `kody-job-state-<owner>-<repo>-<runId>-<timestamp>`.
 * Restore uses a prefix-match restore-keys list to pull the most recent
 * snapshot regardless of which run produced it.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { initialStateEnvelope, isStateEnvelope, type StateEnvelope } from "../issueStateComment.js"
import { isStateUnchanged, type JobStateBackend, type LoadedJobState, stateFilePath } from "./backend.js"

export interface LocalFileBackendOptions {
  /** Absolute path to the consumer repo working tree. */
  cwd: string
  /** Duty directory relative to cwd (e.g. ".kody/duties"). */
  jobsDir: string
  /** Owner/repo are used as cache key components for cross-repo isolation. */
  owner: string
  repo: string
  /**
   * Override the cache adapter (DI seam for tests). When omitted, the
   * default adapter loads `@actions/cache` lazily and is a no-op when
   * GitHub Actions cache env vars are absent.
   */
  cache?: ActionsCacheAdapter
}

/**
 * Minimal interface the local-file backend needs for cache I/O. The default
 * implementation wraps `@actions/cache`; tests inject a stub.
 */
export interface ActionsCacheAdapter {
  /**
   * True when caching is available in this environment (in Actions with the
   * required env vars). When false, hydrate/persist become no-ops.
   */
  isAvailable(): boolean
  /**
   * Try to restore `paths` using `primaryKey` first, falling back through
   * `restoreKeys` (prefix matches). Returns the matched key, or undefined.
   */
  restore(paths: string[], primaryKey: string, restoreKeys?: string[]): Promise<string | undefined>
  /**
   * Save `paths` under `primaryKey`. Throws on transport errors but should
   * swallow "primary key already exists" — caller doesn't care.
   */
  save(paths: string[], primaryKey: string): Promise<void>
}

export class LocalFileBackend implements JobStateBackend {
  readonly name = "local-file"

  private readonly cwd: string
  private readonly jobsDir: string
  private readonly absDir: string
  private readonly owner: string
  private readonly repo: string
  private readonly cache: ActionsCacheAdapter

  constructor(opts: LocalFileBackendOptions) {
    if (!opts.cwd) throw new Error("LocalFileBackend: cwd is required")
    if (!opts.jobsDir) throw new Error("LocalFileBackend: jobsDir is required")
    if (!opts.owner || !opts.repo) throw new Error("LocalFileBackend: owner and repo are required")
    this.cwd = opts.cwd
    this.jobsDir = opts.jobsDir
    this.absDir = path.join(opts.cwd, opts.jobsDir)
    this.owner = opts.owner
    this.repo = opts.repo
    this.cache = opts.cache ?? defaultCacheAdapter()
  }

  /**
   * Restore the job directory from the most recent Actions cache entry
   * for this repo. No-op when not running in Actions or when no cache exists.
   */
  async hydrate(): Promise<void> {
    if (!this.cache.isAvailable()) {
      process.stdout.write(`[jobs/state] hydrate skipped: actions cache unavailable\n`)
      return
    }
    fs.mkdirSync(this.absDir, { recursive: true })
    const prefix = this.cacheKeyPrefix()
    // Primary key uses a never-match suffix so we always fall through to the
    // prefix-match restore-keys, pulling the most recent snapshot.
    const probeKey = `${prefix}probe-${Date.now()}`
    try {
      const matched = await this.cache.restore([this.absDir], probeKey, [prefix])
      if (matched) {
        process.stdout.write(`[jobs/state] hydrate hit: ${matched}\n`)
      } else {
        process.stdout.write(`[jobs/state] hydrate miss (cold start)\n`)
      }
    } catch (err) {
      // Don't fail the run if cache restore is flaky — jobs can reseed.
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[jobs/state] hydrate failed (continuing): ${msg}\n`)
    }
  }

  /**
   * Save the job directory to the Actions cache under a unique key.
   * No-op when not running in Actions. Errors are logged, never thrown —
   * callers run this in a finally block and must not swallow real errors.
   */
  async persist(): Promise<void> {
    if (!this.cache.isAvailable()) {
      process.stdout.write(`[jobs/state] persist skipped: actions cache unavailable\n`)
      return
    }
    if (!fs.existsSync(this.absDir)) {
      // Nothing to save (no job ever ran). Don't error.
      return
    }
    const key = `${this.cacheKeyPrefix()}${process.env.GITHUB_RUN_ID ?? "norunid"}-${Date.now()}`
    try {
      await this.cache.save([this.absDir], key)
      process.stdout.write(`[jobs/state] persist saved: ${key}\n`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[jobs/state] persist failed (continuing): ${msg}\n`)
    }
  }

  load(slug: string): LoadedJobState {
    const relPath = stateFilePath(this.jobsDir, slug)
    const absPath = path.join(this.cwd, relPath)
    if (!fs.existsSync(absPath)) {
      return { path: relPath, handle: null, state: initialStateEnvelope("seed"), created: true }
    }
    const raw = fs.readFileSync(absPath, "utf-8")
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`LocalFileBackend: ${relPath} is not valid JSON: ${msg}`)
    }
    if (!isStateEnvelope(parsed)) {
      throw new Error(`LocalFileBackend: ${relPath} is not a StateEnvelope`)
    }
    return { path: relPath, handle: null, state: parsed, created: false }
  }

  save(loaded: LoadedJobState, next: StateEnvelope): boolean {
    // Same idempotency rule as contents-API: skip when state is structurally
    // unchanged. Avoids unnecessary disk writes (and noise on cache deltas).
    if (!loaded.created && isStateUnchanged(loaded.state, next)) {
      return false
    }
    const absPath = path.join(this.cwd, loaded.path)
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    const body = `${JSON.stringify(next, null, 2)}\n`
    // Write atomically: a crash mid-write (the 5-min tick timeout, OOM, runner
    // teardown) would otherwise leave a truncated file that fails JSON.parse on
    // the next load() and wedges the job until a human deletes it. Write to a
    // sibling temp file, then rename — rename is atomic on the same filesystem.
    const tmpPath = `${absPath}.${process.pid}.tmp`
    fs.writeFileSync(tmpPath, body, "utf-8")
    fs.renameSync(tmpPath, absPath)
    return true
  }

  private cacheKeyPrefix(): string {
    return `kody-job-state-${sanitizeKey(this.owner)}-${sanitizeKey(this.repo)}-`
  }
}

function sanitizeKey(s: string): string {
  // Cache keys can contain alphanumerics, dash, underscore, period. Map
  // anything else to dash so owner/repo with slashes or unicode work.
  return s.replace(/[^A-Za-z0-9._-]/g, "-")
}

/**
 * Default cache adapter — lazy-imports `@actions/cache` so the engine starts
 * cheap when jobs aren't in play. Reports unavailable when not in
 * Actions or when the cache env vars are missing.
 */
function defaultCacheAdapter(): ActionsCacheAdapter {
  type CacheModule = typeof import("@actions/cache")
  let mod: CacheModule | null = null

  const load = async (): Promise<CacheModule> => {
    if (!mod) {
      mod = (await import("@actions/cache")) as CacheModule
    }
    return mod
  }

  const available = (): boolean => {
    if (process.env.GITHUB_ACTIONS !== "true") return false
    // @actions/cache supports both v1 (ACTIONS_CACHE_URL) and v2
    // (ACTIONS_RESULTS_URL). Either env var means caching is reachable.
    return Boolean(process.env.ACTIONS_CACHE_URL || process.env.ACTIONS_RESULTS_URL)
  }

  return {
    isAvailable: available,
    async restore(paths, primaryKey, restoreKeys) {
      if (!available()) return undefined
      const m = await load()
      return m.restoreCache(paths, primaryKey, restoreKeys)
    },
    async save(paths, primaryKey) {
      if (!available()) return
      const m = await load()
      try {
        await m.saveCache(paths, primaryKey)
      } catch (err) {
        // ReserveCacheError = primary key already exists. Treat as success;
        // a prior save with the same key is fine (immutable cache semantics).
        const name = (err as { name?: string })?.name ?? ""
        if (name === "ReserveCacheError") return
        throw err
      }
    },
  }
}
