import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Pin the Claude Code native binary to a stable location.
 *
 * Why this exists: the engine runs via `npx -p @kody-ade/kody-engine`, so the
 * Claude Agent SDK and its platform-specific native binary live under
 * `~/.npm/_npx/<hash>/node_modules`. The SDK re-resolves that binary from disk
 * every time it spawns a phase (classify/research/plan/run/review). During a
 * long run phase the agent does its own npm/pnpm work in the target repo,
 * which makes npm garbage-collect the `_npx` cache out from under the still
 * running engine. Earlier phases already launched the binary; the next spawn
 * (review) then fails with "native binary not found" — a terminal flow abort
 * caused purely by tooling disappearing mid-job.
 *
 * The SDK honors a native-binary path option and, when set, skips its
 * cache-rooted resolver entirely. So we resolve the binary once, copy it to a
 * job-stable directory outside `_npx` (immune to npm GC), and hand that path
 * to every `query()` call. Any failure here returns null and the caller
 * falls back to the SDK's default resolution — no behavior change.
 */

const SDK_PKG = "@anthropic-ai/claude-agent-sdk"

/** Mirror the SDK's own platform-package preference order exactly so we copy
 * the same binary the SDK would have picked (incl. linux musl-before-gnu). */
function candidateSpecs(platform: NodeJS.Platform, arch: string): string[] {
  const ext = platform === "win32" ? ".exe" : ""
  const pkgs =
    platform === "linux"
      ? [`${SDK_PKG}-linux-${arch}-musl`, `${SDK_PKG}-linux-${arch}`]
      : [`${SDK_PKG}-${platform}-${arch}`]
  return pkgs.map((p) => `${p}/claude${ext}`)
}

function readSdkVersion(req: NodeJS.Require): string {
  try {
    const entry = req.resolve(SDK_PKG)
    // entry => .../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
    const pkgDir = path.dirname(entry)
    const raw = fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")
    const v = JSON.parse(raw)?.version
    return typeof v === "string" && v.length > 0 ? v : "unknown"
  } catch {
    return "unknown"
  }
}

let cached: string | null | undefined

/**
 * Resolve the SDK's native binary, copy it to a stable per-(version) path
 * under the OS temp dir, and return that path. Returns null on any failure.
 * Memoized: the copy happens at most once per process.
 */
export function ensureStableClaudeBinary(): string | null {
  if (cached !== undefined) return cached
  try {
    // Root a require at the installed SDK so we resolve the same node_modules
    // tree the SDK itself resolves from.
    const req = createRequire(import.meta.url)
    const sdkEntry = req.resolve(SDK_PKG)
    const sdkReq = createRequire(sdkEntry)

    let source: string | null = null
    for (const spec of candidateSpecs(process.platform, process.arch)) {
      try {
        source = sdkReq.resolve(spec)
        break
      } catch {
        // try next variant
      }
    }
    if (!source || !fs.existsSync(source)) {
      cached = null
      return cached
    }

    const ext = process.platform === "win32" ? ".exe" : ""
    const version = readSdkVersion(req)
    const destDir = path.join(os.tmpdir(), "kody-claude-sdk", version)
    const dest = path.join(destDir, `claude${ext}`)

    const srcSize = fs.statSync(source).size
    if (fs.existsSync(dest) && fs.statSync(dest).size === srcSize) {
      // Already mirrored (same engine/SDK version, same process or a prior
      // one on this runner). Reuse it.
      cached = dest
      return cached
    }

    fs.mkdirSync(destDir, { recursive: true })
    // Atomic: write to a unique temp file in the same dir, then rename, so a
    // concurrent engine process never observes a half-copied binary.
    const tmp = path.join(destDir, `.claude.${process.pid}.${Date.now()}.tmp`)
    fs.copyFileSync(source, tmp)
    fs.chmodSync(tmp, 0o755)
    fs.renameSync(tmp, dest)

    cached = dest
    return cached
  } catch {
    cached = null
    return cached
  }
}
