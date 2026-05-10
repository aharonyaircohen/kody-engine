/**
 * The generic executor.
 *
 * Reads a Profile, validates CLI args, verifies required CLI tools, runs
 * declared preflight scripts, invokes Claude Code, runs declared postflight
 * scripts. Knows nothing about build/review/plan — only about the profile
 * it was handed and the script catalog.
 */

import { execFileSync, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import type { AgentResult } from "./agent.js"
import { runAgent } from "./agent.js"
import type { KodyConfig } from "./config.js"
import { loadConfig, parseProviderModel } from "./config.js"
import type { ContainerChild, Context, InputSpec, Profile, ScriptEntry } from "./executables/types.js"
import { KODY_NAMESPACE, removeLabel } from "./lifecycleLabels.js"
import { startLitellmIfNeeded } from "./litellm.js"
import { loadProfile, validateScriptReferences } from "./profile.js"
import { resolveExecutable } from "./registry.js"
import { allScriptNames, postflightScripts, preflightScripts } from "./scripts/index.js"
import { type Action, readTaskState, type TaskState, type TaskTarget } from "./state.js"
import { firstRequiredFailure, verifyCliTools } from "./tools.js"

const CONTAINER_MAX_ITERATIONS = 50

export interface ExecutorInput {
  cliArgs: Record<string, unknown>
  cwd: string
  /** Pre-loaded config. If omitted, executor loads it from cwd after validating args. */
  config?: KodyConfig
  /** Skip config load entirely (for configless executables like `init`). */
  skipConfig?: boolean
  verbose?: boolean
  quiet?: boolean
  /**
   * Test seam: how a container resolves child invocations. Defaults to
   * `runExecutable` (so containers truly nest). Tests inject a stub to
   * avoid spinning up real executables. Production callers leave this unset.
   */
  __runChild?: (name: string, input: ExecutorInput) => Promise<ExecutorOutput>
  /**
   * Test seam: how a container reads task state between children. Defaults
   * to `readTaskState`. Tests inject a stub that returns the state a mock
   * child "wrote" to skip the gh round-trip.
   */
  __readTaskState?: (target: TaskTarget, number: number, cwd?: string) => TaskState
}

export interface ExecutorOutput {
  exitCode: number
  prUrl?: string
  reason?: string
}

export async function runExecutable(profileName: string, input: ExecutorInput): Promise<ExecutorOutput> {
  const profilePath = resolveProfilePath(profileName)
  const profile = loadProfile(profilePath)

  const missing = validateScriptReferences(profile, allScriptNames)
  if (missing.length > 0) {
    return finish({ exitCode: 99, reason: `profile references unknown scripts: ${missing.join(", ")}` })
  }

  // Validate and coerce CLI args — BEFORE config load so arg errors surface
  // as exit 64 even when a project has no kody.config.json yet.
  let args: Record<string, unknown>
  try {
    args = validateInputs(profile.inputs, input.cliArgs)
  } catch (err) {
    return finish({ exitCode: 64, reason: err instanceof Error ? err.message : String(err) })
  }

  // Verify required CLI tools up front.
  const toolResults = verifyCliTools(profile.cliTools, input.cwd)
  const firstFail = firstRequiredFailure(toolResults, profile.cliTools)
  if (firstFail) {
    return finish({ exitCode: 99, reason: `required CLI tool check failed: ${firstFail.error}` })
  }

  // Resolve config: pre-loaded, loaded on demand, or a placeholder for
  // configless executables.
  let config: KodyConfig
  if (input.config) {
    config = input.config
  } else if (input.skipConfig) {
    config = {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: { model: "claude/claude-haiku-4-5-20251001" },
    }
  } else {
    try {
      config = loadConfig(input.cwd)
    } catch (err) {
      return finish({ exitCode: 99, reason: `config error: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  // Resolve model (profile "inherit" → config.agent.model).
  const modelSpec = profile.claudeCode.model === "inherit" ? config.agent.model : profile.claudeCode.model
  let model: ReturnType<typeof parseProviderModel>
  try {
    model = parseProviderModel(modelSpec)
  } catch (err) {
    return finish({ exitCode: 99, reason: `agent.model invalid: ${err instanceof Error ? err.message : String(err)}` })
  }

  // Start LiteLLM for non-anthropic providers.
  let litellm: Awaited<ReturnType<typeof startLitellmIfNeeded>> = null
  try {
    litellm = await startLitellmIfNeeded(model, input.cwd)
  } catch (err) {
    return finish({
      exitCode: 99,
      reason: `litellm startup failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  const ctx: Context = {
    args,
    cwd: input.cwd,
    config,
    verbose: input.verbose,
    quiet: input.quiet,
    data: {},
    output: { exitCode: 0 },
  }

  const ndjsonDir = path.join(input.cwd, ".kody")
  const invokeAgent = async (prompt: string): Promise<AgentResult> => {
    // Resolve at call time — ctx.data.syntheticPluginPath is set during preflight.
    const externalPlugins = (profile.claudeCode.plugins ?? [])
      .map((p) => (path.isAbsolute(p) ? p : path.resolve(profile.dir, p)))
      .filter((p) => p.length > 0)
    const syntheticPath = ctx.data.syntheticPluginPath as string | undefined
    const pluginPaths = [...externalPlugins, ...(syntheticPath ? [syntheticPath] : [])]

    return runAgent({
      prompt,
      model,
      cwd: input.cwd,
      litellmUrl: litellm?.url ?? null,
      verbose: input.verbose,
      quiet: input.quiet,
      ndjsonDir,
      allowedToolsOverride: profile.claudeCode.tools,
      permissionModeOverride: profile.claudeCode.permissionMode,
      mcpServers: profile.claudeCode.mcpServers.length > 0 ? profile.claudeCode.mcpServers : undefined,
      pluginPaths: pluginPaths.length > 0 ? pluginPaths : undefined,
      maxTurns: profile.claudeCode.maxTurns,
      maxThinkingTokens: profile.claudeCode.maxThinkingTokens,
      systemPromptAppend: profile.claudeCode.systemPromptAppend,
      settingSources: (profile.claudeCode as { settingSources?: Array<"user" | "project" | "local"> }).settingSources,
    })
  }

  // Stash for checkCoverageWithRetry.
  ctx.data.__invokeAgent = invokeAgent

  try {
    // ── Preflight ────────────────────────────────────────────────────────────
    for (const entry of profile.scripts.preflight) {
      if (!shouldRun(entry, ctx)) continue
      if (entry.shell) {
        await runShellEntry(entry, ctx, profile)
        // Shell entries record their outcome via postflight (recordOutcome →
        // saveTaskState → notifyTerminal → advanceFlow). Even on non-zero
        // exit, fall through so the state machine can advance — postflights
        // that should bail (commitAndPush, ensurePr, postIssueComment)
        // already check `ctx.skipAgent && exitCode !== undefined`.
      } else {
        const fn = preflightScripts[entry.script!]
        if (!fn) return finish({ exitCode: 99, reason: `preflight script not registered: ${entry.script}` })
        await fn(ctx, profile, entry.with)
        if (ctx.skipAgent && ctx.output.exitCode !== undefined && ctx.output.exitCode !== 0) {
          // Hard bail from a TS preflight (e.g. uncommitted-changes refusal).
          return finish(ctx.output)
        }
      }
    }

    // ── Agent (or Container children loop) ───────────────────────────────────
    let agentResult: AgentResult | null = null
    if (profile.role === "container") {
      // Containers never run their own agent and never consult the postflight
      // transition table; their orchestration is the children loop below.
      // The postflight on a container should be minimal — typically just
      // persistFlowState — and runs after the loop terminates as usual.
      ctx.skipAgent = true
      await runContainerLoop(profile, ctx, input)
    } else if (!ctx.skipAgent) {
      const prompt = ctx.data.prompt as string | undefined
      if (!prompt) {
        return finish({ exitCode: 99, reason: "composePrompt did not produce a prompt (ctx.data.prompt missing)" })
      }
      agentResult = await invokeAgent(prompt)
    }

    // ── Postflight ────────────────────────────────────────────────────────────
    // NOTE: postflights run unconditionally even after a preflight failure
    // (shell entries set ctx.skipAgent + non-zero exitCode but DO fall
    // through; only TS preflights with skipAgent + non-zero exit hard-bail
    // above). This is deliberate: postIssueComment, writeRunSummary,
    // recordOutcome, mirrorStateToPr, etc. need to fire on failure to
    // surface the failure to the user / state machine. Postflights that
    // MUST NOT run on failure (commitAndPush, ensurePr) self-guard via
    // ctx.skipAgent + ctx.output.exitCode + ctx.data.agentDone checks.
    // When adding a new postflight, default to "safe to run on failure"
    // unless its side effects would corrupt state.
    for (const entry of profile.scripts.postflight) {
      const entryLabel = entry.script ?? entry.shell ?? "<unknown>"
      if (!shouldRun(entry, ctx)) {
        // Make the transition table observable. Orchestrator profiles use
        // runWhen to declare conditional steps; without this log a stalled
        // release looks identical to a successful one — every script
        // silently skipped, no clue which condition didn't match.
        if (entry.runWhen) {
          const reasons: string[] = []
          for (const [key, want] of Object.entries(entry.runWhen)) {
            const actual = resolveDottedPath(ctx, key)
            const wanted = Array.isArray(want) ? want.join("|") : String(want)
            reasons.push(`${key}=${JSON.stringify(actual)} (need ${wanted})`)
          }
          process.stderr.write(`[kody postflight] skip ${entryLabel}: ${reasons.join("; ")}\n`)
        }
        continue
      }
      const label = entryLabel
      try {
        if (entry.shell) {
          await runShellEntry(entry, ctx, profile)
        } else {
          const fn = postflightScripts[entry.script!]
          if (!fn) return finish({ exitCode: 99, reason: `postflight script not registered: ${entry.script}` })
          await fn(ctx, profile, agentResult, entry.with)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[kody] postflight "${label}" crashed: ${msg}\n`)
        // Accumulate reasons across cascading postflight crashes — the first
        // failure may not be the most informative one (e.g. ensurePr crash
        // followed by postIssueComment crash). Operators want every reason
        // visible, not just whichever one happened first.
        const summary = `postflight ${label} crashed: ${msg}`
        ctx.output.reason = ctx.output.reason ? `${ctx.output.reason}; ${summary}` : summary
        if (ctx.output.exitCode === 0) ctx.output.exitCode = 99
      }
    }

    return finish({
      exitCode: ctx.output.exitCode ?? 0,
      prUrl: ctx.output.prUrl,
      reason: ctx.output.reason,
    })
  } finally {
    // Clear any kody:* lifecycle labels stamped by `setLifecycleLabel`
    // preflight entries. Runs on every exit path (normal completion, hard
    // preflight bail, thrown exception) so labels never strand a PR/issue
    // outside the lifecycle taxonomy. Best-effort, never throws.
    clearStampedLifecycleLabels(profile, ctx)
    try {
      litellm?.kill()
    } catch {
      /* best effort */
    }
  }
}

function clearStampedLifecycleLabels(profile: Profile, ctx: Context): void {
  const target = (ctx.args.issue ?? ctx.args.pr) as number | undefined
  if (typeof target !== "number" || !Number.isFinite(target)) return
  for (const entry of profile.scripts.preflight) {
    if (entry.script !== "setLifecycleLabel") continue
    const label = typeof entry.with?.label === "string" ? entry.with.label : undefined
    if (!label || !label.startsWith(KODY_NAMESPACE)) continue
    try {
      removeLabel(target, label, ctx.cwd)
    } catch {
      /* best effort */
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────

function resolveProfilePath(profileName: string): string {
  // Delegate to the registry, which knows about both the consumer-repo
  // root (`.kody/executables/`) and the engine-bundled root. Project roots
  // win on name conflict — letting consumer repos override engine
  // executables or add new ones without forking.
  const found = resolveExecutable(profileName)
  if (found) return found
  // Fall back to the legacy engine-only search so the error surface (file
  // not found) points at the expected engine location, not a project path
  // that may not exist at all.
  const here = path.dirname(new URL(import.meta.url).pathname)
  const candidates = [
    path.join(here, "executables", profileName, "profile.json"), // same-dir sibling (dev)
    path.join(here, "..", "executables", profileName, "profile.json"), // up one (prod: dist/bin → dist/executables)
    path.join(here, "..", "src", "executables", profileName, "profile.json"), // fallback
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[0]!
}

function validateInputs(specs: InputSpec[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  // Build the allowed-key set: the standard globals + every declared input's
  // name, its bare flag key, and the camelCase alias of a dashed flag (since
  // parseGenericFlags emits both shapes for convenience).
  const allowedKeys = new Set<string>(["_", "cwd", "verbose", "quiet"])
  for (const spec of specs) {
    const flagKey = spec.flag.replace(/^--/, "")
    allowedKeys.add(spec.name)
    allowedKeys.add(flagKey)
    if (flagKey.includes("-")) {
      allowedKeys.add(flagKey.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()))
    }
  }
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`unknown arg: --${key}`)
    }
  }

  // First pass: type coerce provided values.
  for (const spec of specs) {
    const v = raw[spec.name]
    if (v === undefined || v === null) continue
    out[spec.name] = coerce(spec, v)
  }

  // Second pass: enforce required / requiredWhen.
  for (const spec of specs) {
    const present = out[spec.name] !== undefined
    if (present) continue
    const isRequired = spec.required === true || satisfiesRequiredWhen(spec.requiredWhen, out)
    if (isRequired) {
      throw new Error(`required input missing: ${spec.flag} (${spec.name})`)
    }
  }

  return out
}

function coerce(spec: InputSpec, v: unknown): unknown {
  switch (spec.type) {
    case "int": {
      const n = typeof v === "number" ? v : parseInt(String(v), 10)
      if (Number.isNaN(n)) throw new Error(`${spec.flag} must be an integer`)
      return n
    }
    case "bool": {
      if (typeof v === "boolean") return v
      const s = String(v).toLowerCase()
      return s === "true" || s === "1" || s === "yes"
    }
    case "enum": {
      const s = String(v)
      if (!spec.values?.includes(s)) throw new Error(`${spec.flag} must be one of: ${spec.values?.join("|")}`)
      return s
    }
    default:
      return String(v)
  }
}

function satisfiesRequiredWhen(rw: InputSpec["requiredWhen"], current: Record<string, unknown>): boolean {
  if (!rw) return false
  for (const [key, want] of Object.entries(rw)) {
    const actual = String(current[key] ?? "")
    const wanted = Array.isArray(want) ? want.map(String) : [String(want)]
    if (wanted.includes(actual)) return true
  }
  return false
}

function shouldRun(entry: ScriptEntry, ctx: Context): boolean {
  if (!entry.runWhen) return true
  for (const [key, want] of Object.entries(entry.runWhen)) {
    const actual = resolveDottedPath(ctx, key)
    const wanted = Array.isArray(want) ? want : [want]
    if (!wanted.map(String).includes(String(actual))) return false
  }
  return true
}

function resolveDottedPath(root: unknown, key: string): unknown {
  const parts = key.split(".")
  let cur: unknown = root
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function finish(out: ExecutorOutput): ExecutorOutput {
  if (out.prUrl) process.stdout.write(`PR_URL=${out.prUrl}\n`)
  else if (out.reason) process.stdout.write(`PR_URL=FAILED: ${out.reason}\n`)
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Shell-script entries. See ScriptEntry.shell in executables/types.ts.
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_SHELL_TIMEOUT_MS = 300_000

/**
 * Resolve the timeout for a shell entry. Precedence:
 *   1. entry.timeoutSec  (per-entry profile override)
 *   2. KODY_SHELL_TIMEOUT_SEC env var (global override)
 *   3. 300s default
 * Returns ms.
 */
function resolveShellTimeoutMs(entry: ScriptEntry): number {
  if (typeof entry.timeoutSec === "number" && entry.timeoutSec > 0) {
    return Math.floor(entry.timeoutSec * 1000)
  }
  const envSec = Number(process.env.KODY_SHELL_TIMEOUT_SEC)
  if (Number.isFinite(envSec) && envSec > 0) {
    return Math.floor(envSec * 1000)
  }
  return DEFAULT_SHELL_TIMEOUT_MS
}

const SIGKILL_GRACE_MS = 5_000

/**
 * Invoke a `.sh` entry. Args from `entry.with` are passed positionally;
 * `ctx.args` and `ctx.config` are exposed as env vars
 * (`KODY_ARG_<UPPER_NAME>=<value>` and `KODY_CFG_<DOTTED_PATH>=<value>`).
 * The script's stdout + stderr are streamed to the parent. Recognized
 * stdout markers:
 *   `KODY_SKIP_AGENT=true` — bypass the agent (preflight did all the work).
 *   `KODY_PR_URL=<url>`    — write into ctx.output.prUrl.
 *   `KODY_REASON=<text>`   — write into ctx.output.reason.
 * Non-zero exit is treated as a preflight failure (executor bails per the
 * standard skipAgent + exit rule).
 *
 * Timeout handling: bash is spawned with `detached: true` so it becomes the
 * leader of a new process group. On timeout we signal the WHOLE group
 * (`process.kill(-pgid, ...)`), first SIGTERM then SIGKILL after a short
 * grace, so descendants (e.g. a `gh` invoking `curl`) cannot leak past the
 * deadline. Surfaced as exit 124 with an explicit "shell '<name>' timed out
 * after Ns" reason — distinct from a script's own non-zero exit.
 */
async function runShellEntry(entry: ScriptEntry, ctx: Context, profile: Profile): Promise<void> {
  const shellName = entry.shell!
  const shellPath = path.join(profile.dir, shellName)
  if (!fs.existsSync(shellPath)) {
    ctx.skipAgent = true
    ctx.output.exitCode = 99
    ctx.output.reason = `shell script not found: ${shellName} (looked in ${profile.dir})`
    return
  }

  const positional = entry.with ? Object.values(entry.with).map((v) => String(v)) : []
  const env: NodeJS.ProcessEnv = { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" }
  for (const [k, v] of Object.entries(ctx.args)) {
    if (v === undefined || v === null) continue
    env[`KODY_ARG_${envKey(k)}`] = String(v)
  }
  for (const [k, v] of flattenConfig(ctx.config as unknown as Record<string, unknown>)) {
    env[`KODY_CFG_${k}`] = v
  }

  const timeoutMs = resolveShellTimeoutMs(entry)

  // detached: true → POSIX setsid, so the child becomes its own process
  // group leader (pgid === pid). That lets us kill descendants on timeout
  // by signalling the negative pid (process group), not just bash itself.
  const child = spawn("bash", [shellPath, ...positional], {
    cwd: ctx.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  })

  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf-8")
    stdout += s
    process.stdout.write(s)
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf-8")
    stderr += s
    process.stderr.write(s)
  })

  let timedOut = false
  let killTimer: NodeJS.Timeout | undefined
  let escalateTimer: NodeJS.Timeout | undefined

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnErr?: Error }>(
    (resolve) => {
      let settled = false
      const settle = (code: number | null, signal: NodeJS.Signals | null, spawnErr?: Error) => {
        if (settled) return
        settled = true
        if (killTimer) clearTimeout(killTimer)
        if (escalateTimer) clearTimeout(escalateTimer)
        resolve({ code, signal, spawnErr })
      }

      child.on("error", (err) => settle(null, null, err))
      child.on("close", (code, signal) => settle(code, signal))

      if (typeof child.pid === "number") {
        const pgid = child.pid
        killTimer = setTimeout(() => {
          timedOut = true
          try {
            process.kill(-pgid, "SIGTERM")
          } catch {
            /* group may already be gone */
          }
          escalateTimer = setTimeout(() => {
            try {
              process.kill(-pgid, "SIGKILL")
            } catch {
              /* ditto */
            }
          }, SIGKILL_GRACE_MS)
        }, timeoutMs)
      }
    },
  )

  if (result.spawnErr) {
    ctx.skipAgent = true
    ctx.output.exitCode = 99
    ctx.output.reason = `shell '${shellName}' failed to spawn: ${result.spawnErr.message}`
    return
  }

  // Stdout marker: opt-in signal that the agent should be bypassed AND
  // the preflight already did all the work. Set exitCode=0 too so
  // postflight scripts (ensurePr, postIssueComment) can bail uniformly
  // on "short-circuited successfully."
  if (/^KODY_SKIP_AGENT=true\s*$/m.test(stdout)) {
    ctx.skipAgent = true
    if (ctx.output.exitCode === undefined) ctx.output.exitCode = 0
  }
  const prUrlMatch = stdout.match(/^KODY_PR_URL=(.+)$/m)
  if (prUrlMatch?.[1]) ctx.output.prUrl = prUrlMatch[1].trim()
  const reasonMatch = stdout.match(/^KODY_REASON=(.+)$/m)
  if (reasonMatch?.[1]) ctx.output.reason = reasonMatch[1].trim()

  if (timedOut) {
    ctx.skipAgent = true
    const seconds = Math.round(timeoutMs / 1000)
    if (ctx.output.exitCode === undefined || ctx.output.exitCode === 0) {
      ctx.output.exitCode = 124
    }
    if (!ctx.output.reason) {
      ctx.output.reason = `shell '${shellName}' timed out after ${seconds}s (process group signalled SIGTERM/SIGKILL)`
    }
    return
  }

  const exit = result.code ?? -1
  if (exit !== 0) {
    ctx.skipAgent = true
    if (ctx.output.exitCode === undefined || ctx.output.exitCode === 0) {
      ctx.output.exitCode = exit
    }
    if (!ctx.output.reason) {
      const tail = (stderr || stdout).slice(-800)
      ctx.output.reason = `shell '${shellName}' exited ${exit}${tail ? `: ${tail}` : ""}`
    }
  }
}

function envKey(name: string): string {
  return name.toUpperCase().replace(/-/g, "_")
}

// ────────────────────────────────────────────────────────────────────────────
// Container loop. Runs children sequentially in-process, routing by each
// child's `next` map over the action type emitted into state.core.lastOutcome.
// Hard cap on iterations so a malformed routing table can't infinite-loop.
// ────────────────────────────────────────────────────────────────────────────

async function runContainerLoop(profile: Profile, ctx: Context, input: ExecutorInput): Promise<void> {
  const children = profile.children
  if (!children || children.length === 0) {
    process.stderr.write(`[kody container] profile "${profile.name}" has no children — nothing to run\n`)
    ctx.output.exitCode = 0
    ctx.output.reason = "container has no children"
    return
  }

  const runChild = input.__runChild ?? ((name, opts) => runExecutable(name, opts))
  const reader = input.__readTaskState ?? readTaskState

  const issueNumber = ctx.args.issue as number | undefined
  let currentIdx = 0
  let iteration = 0
  // prUrl is written by the run child to the issue thread, but later
  // children read state from the PR thread (target-aware). Track it on
  // the loop instead of re-reading from priorState, so once seen it
  // persists across PR-thread reads that don't carry it.
  let knownPrUrl: string | undefined

  while (currentIdx >= 0 && currentIdx < children.length) {
    iteration++
    if (iteration > CONTAINER_MAX_ITERATIONS) {
      const reason = `container exceeded ${CONTAINER_MAX_ITERATIONS} iterations — possible routing loop`
      process.stderr.write(`[kody container] aborting: ${reason}\n`)
      ctx.output.exitCode = 1
      ctx.output.reason = reason
      return
    }

    const child = children[currentIdx]!
    process.stderr.write(`[kody container] step ${iteration}: invoking ${child.exec}\n`)

    // Working-tree reset between children. Each child is built around the
    // assumption it owns a clean tree (legacy orchestrator gave each child
    // a fresh `actions/checkout`). When children share one process, an
    // earlier child's side effects (engine cache writes, generated files,
    // .kody/ artifacts) can leave tracked-file modifications behind that
    // make the next child's runFlow throw UncommittedChangesError.
    // Surfaced on A-Guy issue #1440: plan succeeded, run's preflight bailed
    // because the tree was dirty — we don't know exactly what dirtied it,
    // but a hard reset is a deterministic recovery. Untracked files are
    // left alone (UncommittedChangesError uses --untracked-files=no, so
    // they don't trigger the gate; preserving them keeps node_modules,
    // pip caches, and similar resident.) Best-effort: failures don't abort.
    resetWorkingTree(input.cwd)

    // Idempotency: if state already shows a *_COMPLETED action for this child,
    // skip the invocation and use the stored outcome to route. Lets a
    // re-invoked container resume from where the prior run left off without
    // re-doing committed work (e.g. a plan that already produced an artifact).
    const priorState = readContainerState(ctx, child, reader)
    if (priorState.core?.prUrl) knownPrUrl = priorState.core.prUrl
    const priorAction = priorState.executables?.[child.exec]?.lastAction
    let actionType: string | undefined
    if (priorAction && /_COMPLETED$/i.test(priorAction.type)) {
      process.stderr.write(`[kody container] skipping ${child.exec}: already completed (${priorAction.type})\n`)
      actionType = priorAction.type
    } else {
      // Derive cliArgs from child.target. target=pr requires a known PR;
      // missing prUrl aborts the container with AGENT_NOT_RUN, mirroring how
      // legacy `dispatch.ts` handled the same situation.
      let cliArgs: Record<string, unknown>
      if (child.target === "pr") {
        const prNumber = knownPrUrl ? parsePrNumber(knownPrUrl) : null
        if (!prNumber) {
          const reason = `container child "${child.exec}" needs --pr but state.core.prUrl is unset`
          process.stderr.write(`[kody container] aborting: ${reason}\n`)
          ctx.output.exitCode = 1
          ctx.output.reason = reason
          // Record a synthetic AGENT_NOT_RUN action for downstream postflights.
          const action: Action = {
            type: "AGENT_NOT_RUN",
            payload: { reason, dispatchTarget: "pr", child: child.exec },
            timestamp: new Date().toISOString(),
          }
          ctx.data.action = action
          return
        }
        cliArgs = { pr: prNumber }
      } else {
        if (issueNumber === undefined) {
          const reason = `container child "${child.exec}" needs --issue but ctx.args.issue is unset`
          process.stderr.write(`[kody container] aborting: ${reason}\n`)
          ctx.output.exitCode = 1
          ctx.output.reason = reason
          return
        }
        cliArgs = { issue: issueNumber }
      }

      let childOut: ExecutorOutput
      try {
        childOut = await runChild(child.exec, {
          cliArgs,
          cwd: input.cwd,
          config: input.config,
          skipConfig: input.skipConfig,
          verbose: input.verbose,
          quiet: input.quiet,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[kody container] child "${child.exec}" crashed: ${msg}\n`)
        ctx.output.exitCode = 1
        ctx.output.reason = `child "${child.exec}" crashed: ${msg}`
        return
      }

      // Reload the freshly-written state to discover the action this child
      // emitted. saveTaskState (the standard postflight) is the canonical
      // writer; readTaskState reads the same comment back.
      //
      // Detect "child wrote no new action" by comparing the per-child
      // attempts counter — `reduce()` (state.ts) bumps state.core.attempts
      // on every saveTaskState, so a fresh write is always observable as
      // an increment. Timestamp comparison is unreliable (collisions in
      // same-ms tests, and clocks aren't monotonic anyway). Reference
      // comparison fails across deserialized state reads.
      //
      // When the child bailed before saveTaskState (e.g. runFlow's
      // UncommittedChangesError path on A-Guy issue #1440), the counter
      // is unchanged and we synthesize <EXEC>_COMPLETED|FAILED from the
      // exit code so finishFlow's runWhens can match the actual outcome
      // instead of leaking the prior child's action.
      const priorAttempts = priorState.core?.attempts?.[child.exec] ?? 0
      const next = readContainerState(ctx, child, reader)
      if (next.core?.prUrl) knownPrUrl = next.core.prUrl
      const nextAttempts = next.core?.attempts?.[child.exec] ?? 0
      const nextChildAction = next.executables?.[child.exec]?.lastAction
      const childWrote = nextAttempts > priorAttempts && nextChildAction != null
      if (childWrote && nextChildAction) {
        actionType = nextChildAction.type
      } else {
        const childTag = child.exec.toUpperCase().replace(/-/g, "_")
        actionType = childOut.exitCode === 0 ? `${childTag}_COMPLETED` : `${childTag}_FAILED`
        // Mirror the synthesized action onto core.lastOutcome so postflight
        // runWhens (which read core.lastOutcome.type) see it consistently
        // with the routing decision.
        const synthetic: Action = {
          type: actionType,
          payload: {
            synthesized: true,
            child: child.exec,
            exitCode: childOut.exitCode,
            reason: childOut.reason,
          },
          timestamp: new Date().toISOString(),
        }
        if (!next.core) {
          next.core = {
            phase: "idle",
            status: "pending",
            currentExecutable: null,
            lastOutcome: synthetic,
            attempts: {},
          }
        } else {
          next.core.lastOutcome = synthetic
        }
      }
      ctx.data.taskState = next
    }

    // Route based on action type. Exact match → wildcard "*" → abort.
    const route = child.next[actionType] ?? child.next["*"]
    if (!route) {
      const reason = `no route for action "${actionType}" from child "${child.exec}"`
      process.stderr.write(`[kody container] aborting: ${reason}\n`)
      ctx.output.exitCode = 1
      ctx.output.reason = reason
      return
    }

    process.stderr.write(`[kody container] outcome ${actionType}: dispatching to ${route}\n`)

    if (route === "done") {
      ctx.output.exitCode = 0
      return
    }
    if (route === "abort") {
      ctx.output.exitCode = 1
      ctx.output.reason = `container aborted by route from "${child.exec}" on ${actionType}`
      return
    }

    const nextIdx = children.findIndex((c) => c.exec === route)
    if (nextIdx < 0) {
      const reason = `container route "${route}" does not match any declared child exec name`
      process.stderr.write(`[kody container] aborting: ${reason}\n`)
      ctx.output.exitCode = 1
      ctx.output.reason = reason
      return
    }
    currentIdx = nextIdx
  }
}

/**
 * Discard tracked-file modifications in `cwd` so the next container child
 * sees a clean tree. Best-effort: any error (no git repo, detached HEAD,
 * shallow clone weirdness) is logged and swallowed — this is a recovery
 * tool, not a gate.
 */
function resetWorkingTree(cwd: string): void {
  try {
    execFileSync("git", ["reset", "--hard", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody container] working-tree reset skipped: ${msg}\n`)
  }
}

/**
 * Read the latest task state for the container's routing decision.
 *
 * Each child writes its outcome to the comment thread of whatever target it
 * ran against (saveTaskState reads `ctx.data.commentTargetType`). A child
 * with `target: "pr"` therefore writes its action to the PR's state comment,
 * not the issue's — so the container must read from that same target to see
 * the freshly-written REVIEW_ or FIX_ action. Reading the issue after a `pr`
 * child returns stale state (the prior `run` action) and the wildcard
 * fallback wrongly aborts the flow.
 *
 * Lookup order: child.target's matching thread first, issue fallback for
 * `target: "issue"` children, then the cached preflight state if both gh
 * round-trips fail.
 */
function readContainerState(
  ctx: Context,
  child: ContainerChild,
  reader: (target: TaskTarget, number: number, cwd?: string) => TaskState,
): TaskState {
  const issueNumber = ctx.args.issue as number | undefined
  const cached = ctx.data.taskState as TaskState | undefined
  const prUrl = cached?.core?.prUrl
  const prNumber = prUrl ? parsePrNumber(prUrl) : null

  if (child.target === "pr" && prNumber) {
    try {
      return reader("pr", prNumber, ctx.cwd)
    } catch {
      // Fall through to issue / cache below.
    }
  }
  if (issueNumber !== undefined) {
    try {
      return reader("issue", issueNumber, ctx.cwd)
    } catch {
      // Fall through to cached state below.
    }
  }
  if (cached && typeof cached === "object") {
    return cached
  }
  return {
    schemaVersion: 1,
    core: {
      phase: "idle",
      status: "pending",
      currentExecutable: null,
      lastOutcome: null,
      attempts: {},
    },
    executables: {},
    artifacts: {},
    history: [],
  }
}

function parsePrNumber(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Flatten a config object into [DOTTED_KEY, value] pairs for env-var export.
 * Leaves (string/number/boolean) emit a single entry per dotted path.
 * Arrays are JSON-stringified so shells can `jq -r` them when needed.
 * Nested objects recurse. Skips null/undefined values.
 */
function flattenConfig(obj: Record<string, unknown>, prefix = ""): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue
    const key = prefix ? `${prefix}_${envKey(k)}` : envKey(k)
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out.push([key, String(v)])
    } else if (Array.isArray(v)) {
      out.push([key, JSON.stringify(v)])
    } else if (typeof v === "object") {
      out.push(...flattenConfig(v as Record<string, unknown>, key))
    }
  }
  return out
}
