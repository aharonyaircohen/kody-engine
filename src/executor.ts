/**
 * The generic executor.
 *
 * Reads a Profile, validates CLI args, verifies required CLI tools, runs
 * declared preflight scripts, invokes Claude Code, runs declared postflight
 * scripts. Knows nothing about build/review/plan — only about the profile
 * it was handed and the script catalog.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { AgentResult } from "./agent.js"
import { runAgent } from "./agent.js"
import type { KodyConfig } from "./config.js"
import { loadConfig, parseProviderModel } from "./config.js"
import type { Context, InputSpec, ScriptEntry } from "./executables/types.js"
import { startLitellmIfNeeded } from "./litellm.js"
import { loadProfile, validateScriptReferences } from "./profile.js"
import { allScriptNames, postflightScripts, preflightScripts } from "./scripts/index.js"
import { firstRequiredFailure, verifyCliTools } from "./tools.js"

export interface ExecutorInput {
  cliArgs: Record<string, unknown>
  cwd: string
  /** Pre-loaded config. If omitted, executor loads it from cwd after validating args. */
  config?: KodyConfig
  /** Skip config load entirely (for configless executables like `init`). */
  skipConfig?: boolean
  verbose?: boolean
  quiet?: boolean
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
      quality: { typecheck: "", lint: "", testUnit: "" },
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
      mcpServers: profile.claudeCode.mcpServers as unknown as Array<Record<string, unknown>> | undefined,
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
      const fn = preflightScripts[entry.script]
      if (!fn) return finish({ exitCode: 99, reason: `preflight script not registered: ${entry.script}` })
      await fn(ctx, profile, entry.with)
      if (ctx.skipAgent && ctx.output.exitCode !== undefined && ctx.output.exitCode !== 0) {
        // Hard bail from preflight (e.g. uncommitted-changes refusal).
        return finish(ctx.output)
      }
    }

    // ── Agent ─────────────────────────────────────────────────────────────────
    let agentResult: AgentResult | null = null
    if (!ctx.skipAgent) {
      const prompt = ctx.data.prompt as string | undefined
      if (!prompt) {
        return finish({ exitCode: 99, reason: "composePrompt did not produce a prompt (ctx.data.prompt missing)" })
      }
      agentResult = await invokeAgent(prompt)
    }

    // ── Postflight ────────────────────────────────────────────────────────────
    for (const entry of profile.scripts.postflight) {
      if (!shouldRun(entry, ctx)) continue
      const fn = postflightScripts[entry.script]
      if (!fn) return finish({ exitCode: 99, reason: `postflight script not registered: ${entry.script}` })
      try {
        await fn(ctx, profile, agentResult, entry.with)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[kody] postflight script "${entry.script}" crashed: ${msg}\n`)
        // Don't let one failing postflight (e.g. writeRunSummary, flaky gh call)
        // prevent subsequent postflights (e.g. PR comment) from running.
        if (!ctx.output.reason) ctx.output.reason = `postflight ${entry.script} crashed: ${msg}`
        if (ctx.output.exitCode === 0) ctx.output.exitCode = 99
      }
    }

    return finish({
      exitCode: ctx.output.exitCode ?? 0,
      prUrl: ctx.output.prUrl,
      reason: ctx.output.reason,
    })
  } finally {
    try {
      litellm?.kill()
    } catch {
      /* best effort */
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────

function resolveProfilePath(profileName: string): string {
  // Resolve profile in both layouts:
  //   - dev / tsx: src/executor.ts    → src/executables/<name>/profile.json
  //   - prod bundle: dist/bin/kody.js → dist/executables/<name>/profile.json
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
