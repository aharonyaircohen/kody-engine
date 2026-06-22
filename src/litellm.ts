import { execFileSync, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { LITELLM_DEFAULT_URL, needsLitellmProxy, type ProviderModel, providerApiKeyEnvVar } from "./config.js"

export async function checkLitellmHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}

// LiteLLM 1.86.x cold-boots slowly on a fresh CI runner — `import litellm`
// drags in boto3/azure/vertex and uvicorn startup, observed at ~60-65s before
// `/health` first answers. A 60s deadline lost that race by a few seconds and
// threw "failed to start" even though the proxy came up moments later (the real
// cause behind the "unreachable proxy" empty-PR runs). 150s gives ample margin
// for a slow runner without hanging a genuinely dead proxy for too long.
const DEFAULT_LITELLM_STARTUP_TIMEOUT_SEC = 150
const LITELLM_HEALTH_POLL_INTERVAL_MS = 2000

/**
 * Resolve the LiteLLM startup deadline. Precedence:
 *   1. KODY_LITELLM_TIMEOUT_SEC env var
 *   2. 60s default
 * Returns the total time (ms) we'll wait for `/health` to return ok.
 */
function resolveLitellmTimeoutMs(): number {
  const envSec = Number(process.env.KODY_LITELLM_TIMEOUT_SEC)
  if (Number.isFinite(envSec) && envSec > 0) return Math.floor(envSec * 1000)
  return DEFAULT_LITELLM_STARTUP_TIMEOUT_SEC * 1000
}

export function generateLitellmConfigYaml(model: ProviderModel): string {
  const apiKeyVar = providerApiKeyEnvVar(model.provider)
  return [
    "model_list:",
    `  - model_name: ${model.model}`,
    `    litellm_params:`,
    `      model: ${model.provider}/${model.model}`,
    `      api_key: os.environ/${apiKeyVar}`,
    "",
    "litellm_settings:",
    "  drop_params: true",
    "",
  ].join("\n")
}

export interface LitellmHandle {
  url: string
  kill: () => void
  /**
   * Pure liveness probe — hits `/health` and returns the result with NO side
   * effect (never restarts). Used to decide whether a session that the SDK
   * reported as "success" is actually hollow: if the proxy is dead right after
   * the turn, the model never answered (it crashed mid-request and the SDK
   * still emitted a 1-turn / $0 "success"). Demotion uses this; recovery uses
   * `ensureHealthy`.
   */
  isHealthy: () => Promise<boolean>
  /**
   * Ensure the proxy is reachable. If `/health` fails — the proxy crashed or
   * hung mid-run (the Approval Gate failure mode: a heavy request kills the
   * single agent, after which every connection is refused) — this dumps the
   * proxy's log tail so the crash reason is visible in the run log, then
   * respawns it and waits for health. Returns true when the proxy is healthy
   * (already, or after a restart).
   */
  ensureHealthy: () => Promise<boolean>
}

/** True when `import litellm` succeeds under python3. */
function litellmImportable(): boolean {
  try {
    execFileSync("python3", ["-c", "import litellm"], { timeout: 10000, stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/** Absolute path to the `litellm` console script next to the active python3, or null. */
function locateLitellmScript(): string | null {
  try {
    const out = execFileSync(
      "python3",
      [
        "-c",
        "import os,sys; p=os.path.join(os.path.dirname(sys.executable),'litellm'); print(p if os.path.exists(p) else '')",
      ],
      { encoding: "utf-8", timeout: 10_000 },
    ).trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * Resolve a runnable litellm proxy launcher, installing on demand if missing.
 *
 * Returns the bare `litellm` (when on PATH) or an absolute path to the installed
 * `litellm` console script. `python3 -m litellm` is NOT valid — litellm has no
 * `__main__` — so when the CLI isn't on PATH we must locate the console script.
 *
 * Installing here covers every entry path uniformly (the proxy only starts when
 * a non-Anthropic model needs it). Historically only the `ci` preflight
 * pip-installed litellm, so a scheduled duty invoked as `kody-engine
 * <executable>` directly failed with "litellm not installed".
 */
export function resolveLitellmCommand(): string {
  try {
    execFileSync("which", ["litellm"], { timeout: 3000, stdio: "pipe" })
    return "litellm"
  } catch {
    if (!litellmImportable()) {
      process.stderr.write("→ kody: litellm not found — installing (pip install 'litellm[proxy]')\n")
      let installed = false
      for (const pip of ["pip", "pip3"]) {
        try {
          execFileSync(pip, ["install", "litellm[proxy]"], { timeout: 300_000, stdio: "inherit" })
          installed = true
          break
        } catch {
          /* try next */
        }
      }
      if (!installed || !litellmImportable()) {
        throw new Error("litellm not installed and auto-install failed — run: pip install 'litellm[proxy]'")
      }
    }
    const script = locateLitellmScript()
    if (script) return script
    throw new Error("litellm is importable but its console script was not found next to python3")
  }
}

export async function startLitellmIfNeeded(
  model: ProviderModel,
  projectDir: string,
  url: string = LITELLM_DEFAULT_URL,
): Promise<LitellmHandle | null> {
  if (!needsLitellmProxy(model)) return null

  const cmd = resolveLitellmCommand()
  const portMatch = url.match(/:(\d+)/)
  const port = portMatch ? portMatch[1] : "4000"
  const childEnv = stripBlockingEnv({ ...process.env, ...readDotenvApiKeys(projectDir) })

  // Mutable handle state. `ensureHealthy` can replace `child` when it respawns
  // a crashed proxy; `kill` and the log-tail dump always act on whatever is
  // current. `child` stays undefined when we reuse a proxy someone else
  // started (nothing of ours to kill) — until we have to respawn it ourselves.
  let child: ReturnType<typeof spawn> | undefined
  let logPath: string | undefined

  const spawnProxy = (): void => {
    const configPath = path.join(os.tmpdir(), `kody-local-litellm-${Date.now()}.yaml`)
    fs.writeFileSync(configPath, generateLitellmConfigYaml(model))
    // `cmd` is always a runnable litellm CLI (the bare command or an absolute
    // path to the console script), so the proxy args are uniform.
    const args = ["--config", configPath, "--port", port]
    const nextLogPath = path.join(os.tmpdir(), `kody-local-litellm-${Date.now()}.log`)
    const outFd = fs.openSync(nextLogPath, "w")
    child = spawn(cmd, args, { stdio: ["ignore", outFd, outFd], detached: true, env: childEnv })
    fs.closeSync(outFd)
    logPath = nextLogPath
  }

  const waitForHealth = async (): Promise<boolean> => {
    const deadline = Date.now() + resolveLitellmTimeoutMs()
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, LITELLM_HEALTH_POLL_INTERVAL_MS))
      if (await checkLitellmHealth(url)) return true
    }
    return false
  }

  const readLogTail = (): string => {
    if (!logPath) return ""
    try {
      return fs.readFileSync(logPath, "utf-8").slice(-2000)
    } catch {
      return ""
    }
  }

  const killChild = (): void => {
    const pid = child?.pid
    if (typeof pid !== "number") return
    // The proxy is spawned `detached: true`, so it leads its own process group
    // and forks an agent (uvicorn) that actually holds the port. `child.kill()`
    // signals only the immediate PID, leaving the agent alive to squat port
    // 4000 and get "reused" by a later run. Signal the whole group (negative
    // pid), SIGTERM then SIGKILL after a short grace.
    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      try {
        child?.kill()
      } catch {
        /* best effort */
      }
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        /* group already gone — fine */
      }
    }, 2_000).unref?.()
  }

  const ensureHealthy = async (): Promise<boolean> => {
    if (await checkLitellmHealth(url)) return true
    const tail = readLogTail()
    process.stderr.write(
      `[kody litellm] proxy unreachable mid-run; restarting.${tail ? ` Last log:\n${tail}\n` : "\n"}`,
    )
    killChild()
    spawnProxy()
    return waitForHealth()
  }

  const isHealthy = (): Promise<boolean> => checkLitellmHealth(url)

  // Reuse a proxy already serving this url (started by an earlier task).
  if (await checkLitellmHealth(url)) {
    return { url, kill: killChild, isHealthy, ensureHealthy }
  }

  spawnProxy()
  if (!(await waitForHealth())) {
    const tail = readLogTail()
    killChild()
    const seconds = Math.round(resolveLitellmTimeoutMs() / 1000)
    throw new Error(
      `LiteLLM proxy failed to start within ${seconds}s (KODY_LITELLM_TIMEOUT_SEC overrides). Log tail:\n${tail}`,
    )
  }
  return { url, kill: killChild, isHealthy, ensureHealthy }
}

function readDotenvApiKeys(projectDir: string): Record<string, string> {
  const dotenvPath = path.join(projectDir, ".env")
  if (!fs.existsSync(dotenvPath)) return {}
  const result: Record<string, string> = {}
  for (const rawLine of fs.readFileSync(dotenvPath, "utf-8").split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const match = line.match(/^([A-Z_][A-Z0-9_]*_API_KEY)=(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    const commentIdx = value.indexOf(" #")
    if (commentIdx !== -1) value = value.slice(0, commentIdx).trim()
    if (value) result[match[1]] = value
  }
  return result
}

function stripBlockingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  delete out.DATABASE_URL
  delete out.AI_BASE_URL
  return out
}
