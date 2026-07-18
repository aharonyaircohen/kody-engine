/**
 * Minimal Convex client for the engine's chat session store.
 *
 * Mirrors the dashboard monorepo's wrapper (kody-chat
 * packages/kody-backend/src/client.ts + escape-keys.ts) — copied, not
 * imported, because the engine is a separate repo/package. Two concerns:
 *
 * 1. Reserved-key escaping: Convex rejects object keys starting with `$`/`_`
 *    at the wire, so payload keys are deep-escaped on the way in (prepend
 *    `~` to keys starting with `$`, `_`, or `~`) and unescaped on the way
 *    out. The scheme is reversible and collision-proof.
 * 2. Service auth: every Convex function accepts a `serviceKey` arg verified
 *    against the deployment's KODY_SERVICE_KEY. It is injected here from the
 *    engine's env (an Actions secret, unpacked via ALL_SECRETS) so call
 *    sites never mention it.
 */

import { ConvexHttpClient } from "convex/browser"

const ESCAPE_CHAR = "~"
const NEEDS_ESCAPE = /^[$_~]/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function deepMapKeys(value: unknown, mapKey: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => deepMapKeys(item, mapKey))
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [mapKey(key), deepMapKeys(item, mapKey)]))
  }
  return value
}

/** Deeply escapes reserved-prefix keys so any payload is storable in Convex. */
export function deepEscapeKeys<T>(value: T): T {
  return deepMapKeys(value, (k) => (NEEDS_ESCAPE.test(k) ? `${ESCAPE_CHAR}${k}` : k)) as T
}

/** Reverses {@link deepEscapeKeys} — reads return the original keys. */
export function deepUnescapeKeys<T>(value: T): T {
  return deepMapKeys(value, (k) => (k.startsWith(ESCAPE_CHAR) ? k.slice(1) : k)) as T
}

type CallMethod = "query" | "mutation" | "action"
const CALL_METHODS: readonly CallMethod[] = ["query", "mutation", "action"]

function injectServiceKey(args: unknown, serviceKey = process.env.KODY_SERVICE_KEY): unknown {
  if (!serviceKey) return args
  if (args === undefined) return { serviceKey }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args
  return { ...args, serviceKey }
}

/**
 * Wraps a ConvexHttpClient so query/mutation/action args are deep-escaped
 * (and results unescaped) and the KODY_SERVICE_KEY service secret is
 * injected into every call.
 */
export function withEscapedKeys(client: ConvexHttpClient, serviceKey = process.env.KODY_SERVICE_KEY): ConvexHttpClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (CALL_METHODS.includes(prop as CallMethod)) {
        const method = Reflect.get(target, prop, target) as (fn: unknown, args?: unknown) => Promise<unknown>
        return async (fn: unknown, args?: unknown) => {
          const authed = injectServiceKey(args, serviceKey)
          const result = await method.call(target, fn, authed === undefined ? undefined : deepEscapeKeys(authed))
          return deepUnescapeKeys(result)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/**
 * Client factory for the engine runner. Returns null when CONVEX_URL is not
 * configured (Actions secrets may not be set yet) — callers fall back to the
 * legacy backend JSONL path.
 */
export function createConvexClientFromEnv(env: NodeJS.ProcessEnv = process.env): ConvexHttpClient | null {
  const url = env.CONVEX_URL?.trim()
  if (!url) return null
  return withEscapedKeys(new ConvexHttpClient(url), env.KODY_SERVICE_KEY)
}
