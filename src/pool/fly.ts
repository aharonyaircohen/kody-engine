/**
 * Fly Machines API client for the warm-pool owner. Creates, freezes, wakes,
 * and destroys pooled one-shot runner machines. Mirrors the dashboard's
 * brain-fly flyFetch shape (same API surface, https://api.machines.dev/v1).
 *
 * Pooled machines:
 *   - image      = the kody-runner image (entrypoint overridden to serve mode)
 *   - entrypoint = /usr/local/bin/entrypoint-serve.sh (boots `kody runner-serve`)
 *   - env        = RUNNER_API_KEY, KODY_LITELLM_URL, PORT
 *   - auto_destroy=true, restart=no  (one-shot: dies after its single job)
 *   - metadata.kody_pool = "1"        (so the owner can reconcile on restart)
 */

const FLY_API_BASE = "https://api.machines.dev/v1"

export const POOL_METADATA_KEY = "kody_pool"
export const POOL_METADATA_VALUE = "1"
/** Per-repo tag so each repo's pool only manages its own machines. */
export const POOL_REPO_METADATA_KEY = "kody_pool_repo"

export interface FlyGuest {
  cpu_kind: "shared" | "performance"
  cpus: number
  memory_mb: number
}

export interface FlyMachine {
  id: string
  state?: string
  private_ip?: string
  region?: string
  config?: {
    metadata?: Record<string, string>
    env?: Record<string, string>
  }
}

export interface FlyClientOptions {
  token: string
  app: string
  /** Seam for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export class FlyClient {
  constructor(private readonly opts: FlyClientOptions) {
    if (!opts.token?.trim()) throw new Error("FlyClient: token required")
    if (!opts.app?.trim()) throw new Error("FlyClient: app required")
  }

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch
  }

  private async call<T>(
    path: string,
    init: { method?: string; body?: unknown; allow404?: boolean } = {},
  ): Promise<T | null> {
    const res = await this.fetch(`${FLY_API_BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        "Content-Type": "application/json",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    if (res.status === 404 && init.allow404) return null
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Fly API ${res.status} on ${path}: ${text.slice(0, 200) || res.statusText}`)
    }
    if (res.status === 204) return null
    const raw = await res.text()
    if (!raw.trim()) return null
    return JSON.parse(raw) as T
  }

  /** Create + start a pooled machine in serve mode, tagged for `repoTag`. */
  async createPooled(input: {
    image: string
    region: string
    guest: FlyGuest
    runnerApiKey: string
    litellmUrl: string
    repoTag: string
    port?: number
  }): Promise<FlyMachine> {
    const body = {
      region: input.region,
      config: {
        image: input.image,
        guest: input.guest,
        auto_destroy: true,
        restart: { policy: "no" },
        init: { entrypoint: ["/usr/local/bin/entrypoint-serve.sh"] },
        metadata: {
          [POOL_METADATA_KEY]: POOL_METADATA_VALUE,
          [POOL_REPO_METADATA_KEY]: input.repoTag,
        },
        env: {
          RUNNER_API_KEY: input.runnerApiKey,
          KODY_LITELLM_URL: input.litellmUrl,
          PORT: String(input.port ?? 8080),
        },
      },
    }
    const m = await this.call<FlyMachine>(`/apps/${enc(this.opts.app)}/machines`, { method: "POST", body })
    if (!m?.id) throw new Error("Fly API: createPooled returned no machine id")
    return m
  }

  async get(id: string): Promise<FlyMachine | null> {
    return this.call<FlyMachine>(`/apps/${enc(this.opts.app)}/machines/${enc(id)}`, { allow404: true })
  }

  /**
   * List pooled machines for `repoTag` (kody_pool + matching repo tag),
   * excluding destroyed/destroying. Each repo's pool sees only its own.
   */
  async listPooled(repoTag: string): Promise<FlyMachine[]> {
    const all = (await this.call<FlyMachine[]>(`/apps/${enc(this.opts.app)}/machines`, { allow404: true })) ?? []
    return all.filter(
      (m) =>
        m.config?.metadata?.[POOL_METADATA_KEY] === POOL_METADATA_VALUE &&
        m.config?.metadata?.[POOL_REPO_METADATA_KEY] === repoTag &&
        m.state !== "destroyed" &&
        m.state !== "destroying",
    )
  }

  /** Suspend (freeze) a machine — wakes in ~1s from the snapshot. */
  async suspend(id: string): Promise<void> {
    await this.call(`/apps/${enc(this.opts.app)}/machines/${enc(id)}/suspend`, { method: "POST", allow404: true })
  }

  /** Start (wake) a suspended/stopped machine. */
  async start(id: string): Promise<void> {
    await this.call(`/apps/${enc(this.opts.app)}/machines/${enc(id)}/start`, { method: "POST", allow404: true })
  }

  async destroy(id: string): Promise<void> {
    await this.call(`/apps/${enc(this.opts.app)}/machines/${enc(id)}?force=true`, { method: "DELETE", allow404: true })
  }

  /**
   * Wait for `GET <baseUrl>/healthz` to return 200, polling until timeout.
   * baseUrl is the machine's private 6PN address (http://[ip]:port).
   */
  async waitHealthy(baseUrl: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
    const timeoutMs = opts.timeoutMs ?? 120_000
    const intervalMs = opts.intervalMs ?? 1_000
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const res = await this.fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(4_000) })
        if (res.ok) return true
      } catch {
        /* not up yet */
      }
      await sleep(intervalMs)
    }
    return false
  }
}

function enc(s: string): string {
  return encodeURIComponent(s)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
