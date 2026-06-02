/**
 * The generic executor.
 *
 * Reads a Profile, validates CLI args, verifies required CLI tools, runs
 * declared preflight scripts, invokes Claude Code, runs declared postflight
 * scripts. Knows nothing about build/review/plan — only about the profile
 * it was handed and the script catalog.
 */

import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import type { AgentResult } from "./agent.js"
import { runAgent } from "./agent.js"
import type { KodyConfig } from "./config.js"
import { loadConfig, parseProviderModel } from "./config.js"
import { runContainerLoop } from "./container.js"
import { DISCIPLINE } from "./discipline.js"
import { emitEvent } from "./events.js"
import type { Context, InputSpec, Profile, ScriptEntry } from "./executables/types.js"
import { KODY_NAMESPACE, removeLabel } from "./lifecycleLabels.js"
import { startLitellmIfNeeded } from "./litellm.js"
import { loadProfile, validateScriptReferences } from "./profile.js"
import { resolveExecutable } from "./registry.js"
import { allScriptNames, postflightScripts, preflightScripts } from "./scripts/index.js"
import type { TaskState, TaskTarget } from "./state.js"
import { loadSubagents } from "./subagents.js"
import { prepareTaskArtifactsDir, taskArtifactsPromptAddendum, verifyTaskArtifacts } from "./task-artifacts.js"
import { firstRequiredFailure, verifyCliTools } from "./tools.js"

/**
 * Postflights that MUST NOT mutate shared git/PR state on a failed run.
 * The executor refuses to run these whenever the run has already recorded a
 * failure (see the postflight loop) — making failure-safety a structural
 * guarantee rather than a per-script convention. A postflight that pushes
 * commits, opens/edits PRs, or otherwise changes durable external state
 * belongs here. Adding one without listing it here is a bug:
 * `tests/unit/postflightFailureSafety.test.ts` enforces the contract.
 */
const MUTATING_POSTFLIGHTS: ReadonlySet<string> = new Set(["commitAndPush", "ensurePr"])

/** True when `scriptName` is a state-mutating postflight (see MUTATING_POSTFLIGHTS). */
export function isMutatingPostflight(scriptName: string | undefined): boolean {
  return MUTATING_POSTFLIGHTS.has(scriptName ?? "")
}

/**
 * The executor's failure-safety decision: block a state-mutating postflight
 * once the run has recorded ANY non-zero exit code. Exported so the contract
 * is unit-testable independently of the (un-exported) postflight loop.
 */
export function shouldBlockMutatingPostflight(scriptName: string | undefined, exitCode: number | undefined): boolean {
  return isMutatingPostflight(scriptName) && (exitCode ?? 0) !== 0
}

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
  /**
   * Phase 5 foundation: pre-populated `ctx.data` entries seeded into the
   * child's context before any preflight runs. Container loops use this
   * to hand the cached `taskContext` (and individual loader outputs
   * like `issue`, `conventions`, `priorArt`, `memoryContext`,
   * `coverageRules`) to children so the children's context-loading
   * preflights can short-circuit instead of re-querying GitHub +
   * re-reading the filesystem.
   *
   * Entries here merge into `ctx.data` BEFORE preflights run; loaders
   * check for their respective fields and skip when already populated.
   * Safe to leave unset for everything — the loaders' fast paths are
   * additive.
   */
  preloadedData?: Record<string, unknown>
}

export interface ExecutorOutput {
  exitCode: number
  prUrl?: string
  reason?: string
  /**
   * In-process stage hand-off. When a stage (e.g. `classify`) decides which
   * stage runs next, it sets `ctx.output.nextDispatch` instead of posting an
   * `@kody <next>` comment. The orchestration layer (kody-cli) runs it in the
   * SAME process. This replaces the old comment round-trip, which deadlocked
   * when Kody ran as a GitHub App: the hand-off comment was bot-authored and
   * the follow-up run silently ignored it, stalling the pipeline at classify.
   */
  nextDispatch?: { executable: string; cliArgs: Record<string, unknown> }
}

export async function runExecutable(profileName: string, input: ExecutorInput): Promise<ExecutorOutput> {
  const stageStartedAt = Date.now()
  emitEvent(input.cwd, { executable: profileName, kind: "stage_start" })
  const finishAndEnd = (out: ExecutorOutput): ExecutorOutput => {
    emitEvent(input.cwd, {
      executable: profileName,
      kind: "stage_end",
      durationMs: Date.now() - stageStartedAt,
      outcome: out.exitCode === 0 ? "ok" : "failed",
      meta: {
        exitCode: out.exitCode,
        ...(out.reason ? { reason: out.reason } : {}),
        ...(out.prUrl ? { prUrl: out.prUrl } : {}),
      },
    })
    if (out.prUrl) process.stdout.write(`PR_URL=${out.prUrl}\n`)
    else if (out.reason) process.stdout.write(`PR_URL=FAILED: ${out.reason}\n`)
    return out
  }

  const profilePath = resolveProfilePath(profileName)
  const profile = loadProfile(profilePath)

  const missing = validateScriptReferences(profile, allScriptNames)
  if (missing.length > 0) {
    return finishAndEnd({ exitCode: 99, reason: `profile references unknown scripts: ${missing.join(", ")}` })
  }

  // Validate and coerce CLI args — BEFORE config load so arg errors surface
  // as exit 64 even when a project has no kody.config.json yet.
  let args: Record<string, unknown>
  try {
    args = validateInputs(profile.inputs, input.cliArgs)
  } catch (err) {
    return finishAndEnd({ exitCode: 64, reason: err instanceof Error ? err.message : String(err) })
  }

  // Verify required CLI tools up front.
  const toolResults = verifyCliTools(profile.cliTools, input.cwd)
  const firstFail = firstRequiredFailure(toolResults, profile.cliTools)
  if (firstFail) {
    return finishAndEnd({ exitCode: 99, reason: `required CLI tool check failed: ${firstFail.error}` })
  }

  // Resolve config: pre-loaded, loaded on demand, or a placeholder for
  // configless executables.
  let config: KodyConfig
  if (input.config) {
    config = input.config
  } else if (input.skipConfig) {
    // No kody.config.json (e.g. init, or brain-serve booting without a work
    // repo). Honour the MODEL env var so a repo-less Brain still runs the
    // user's chosen model; fall back to a safe default otherwise.
    const envModel = process.env.MODEL?.trim()
    config = {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: { model: envModel || "claude/claude-haiku-4-5-20251001" },
    }
  } else {
    try {
      config = loadConfig(input.cwd)
    } catch (err) {
      return finishAndEnd({ exitCode: 99, reason: `config error: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  // Resolve model. Precedence:
  //   1. config.agent.perExecutable[profileName] (per-stage override)
  //   2. profile.claudeCode.model (when not "inherit")
  //   3. config.agent.model (default for everything else)
  const perExecutableModel = config.agent.perExecutable?.[profileName]
  const modelSpec = perExecutableModel
    ? perExecutableModel
    : profile.claudeCode.model === "inherit"
      ? config.agent.model
      : profile.claudeCode.model
  let model: ReturnType<typeof parseProviderModel>
  try {
    model = parseProviderModel(modelSpec)
  } catch (err) {
    return finishAndEnd({
      exitCode: 99,
      reason: `agent.model invalid: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  // Start LiteLLM for non-anthropic providers — unless this is a
  // build-only executable (preview-build) that runs no model. Those skip
  // the litellm *install* in preflight, so starting it here would fail.
  let litellm: Awaited<ReturnType<typeof startLitellmIfNeeded>> = null
  if (profileName !== "preview-build") {
    try {
      litellm = await startLitellmIfNeeded(model, input.cwd)
    } catch (err) {
      return finishAndEnd({
        exitCode: 99,
        reason: `litellm startup failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  const ctx: Context = {
    args,
    cwd: input.cwd,
    config,
    verbose: input.verbose,
    quiet: input.quiet,
    // Phase 5 foundation: seed ctx.data with any preloaded values handed
    // in by a parent (typically a container loop). Loaders that see
    // their field already populated take the fast path and skip the
    // re-fetch. Always-on; preloadedData defaults to {} when unset.
    data: { ...(input.preloadedData ?? {}) },
    output: { exitCode: 0 },
  }

  // Per-task artifacts: if this run targets a concrete issue or PR,
  // prepare `.kody/tasks/<id>/` so the agent can write context.json /
  // memory-recs.json / followups.json / handoff-notes.md as its final
  // act. Skipped for executables that have no issue/PR target (e.g.
  // brain-serve, dispatchers, system tasks) — those produce no artifacts.
  const taskTarget = (args.issue ?? args.pr) as number | undefined
  const taskArtifacts =
    typeof taskTarget === "number" && Number.isFinite(taskTarget)
      ? (() => {
          const taskType: "issue" | "pr" = args.issue ? "issue" : "pr"
          const paths = prepareTaskArtifactsDir(input.cwd, taskTarget)
          return {
            ...paths,
            taskType,
            promptAddendum: taskArtifactsPromptAddendum({
              taskId: paths.taskId,
              taskType,
              relDir: paths.relDir,
            }),
          }
        })()
      : null

  const ndjsonDir = path.join(input.cwd, ".kody")
  const invokeAgent = async (prompt: string): Promise<AgentResult> => {
    // Resolve at call time — ctx.data.syntheticPluginPath is set during preflight.
    const externalPlugins = (profile.claudeCode.plugins ?? [])
      .map((p) => (path.isAbsolute(p) ? p : path.resolve(profile.dir, p)))
      .filter((p) => p.length > 0)
    const syntheticPath = ctx.data.syntheticPluginPath as string | undefined
    const pluginPaths = [...externalPlugins, ...(syntheticPath ? [syntheticPath] : [])]
    const agents = loadSubagents(profile)

    const lm = litellm
    return runAgent({
      prompt,
      model,
      cwd: input.cwd,
      litellmUrl: lm?.url ?? null,
      // On a connection drop mid-run, restart the (possibly crashed) proxy
      // before the agent retries. No-op for direct-Anthropic runs (lm null).
      ensureBackend: lm ? () => lm.ensureHealthy().then(() => undefined) : undefined,
      // Pure liveness probe so the agent can spot a hollow "success" (proxy
      // crashed mid-request, SDK still reported success). No-op when lm null.
      isBackendHealthy: lm ? () => lm.isHealthy() : undefined,
      verbose: input.verbose,
      quiet: input.quiet,
      ndjsonDir,
      allowedToolsOverride: profile.claudeCode.tools,
      permissionModeOverride: profile.claudeCode.permissionMode,
      mcpServers: profile.claudeCode.mcpServers.length > 0 ? profile.claudeCode.mcpServers : undefined,
      pluginPaths: pluginPaths.length > 0 ? pluginPaths : undefined,
      agents,
      maxTurns: profile.claudeCode.maxTurns,
      maxThinkingTokens: profile.claudeCode.maxThinkingTokens,
      maxTurnTimeoutMs:
        typeof profile.claudeCode.maxTurnTimeoutSec === "number"
          ? Math.floor(profile.claudeCode.maxTurnTimeoutSec * 1000)
          : undefined,
      // DISCIPLINE leads so the stable, role-agnostic block sits at the front
      // of the cacheable system-prompt prefix; profile/task appends follow.
      systemPromptAppend:
        [DISCIPLINE, profile.claudeCode.systemPromptAppend, taskArtifacts?.promptAddendum]
          .filter((s): s is string => typeof s === "string" && s.length > 0)
          .join("\n\n") || undefined,
      cacheable: profile.claudeCode.cacheable,
      enableVerifyTool: profile.claudeCode.enableVerifyTool,
      enableSubmitTool: profile.claudeCode.enableSubmitTool,
      // Locked-toolbox duty mode: `loadJobFromFile` flips `ctx.data.dutyTools`
      // when a duty declares `tools:` frontmatter. The executor doesn't need
      // to know the palette — it just forwards the flag so agent.ts can spin
      // up the in-process `kody-duty` MCP server with the right context.
      enableDutyTool: Array.isArray(ctx.data.dutyTools) && ctx.data.dutyTools.length > 0,
      dutyOperatorMention:
        typeof ctx.data.dutyOperatorMention === "string" ? (ctx.data.dutyOperatorMention as string) : undefined,
      // Stamp the running duty's slug onto recommendations so the dashboard
      // keys trust per duty (not per persona). `jobSlug` is set by loadJobFromFile.
      dutyDutySlug: typeof ctx.data.jobSlug === "string" ? (ctx.data.jobSlug as string) : undefined,
      // owner/repo from kody.config.json; envelope falls back to GITHUB_REPOSITORY
      // for tester repos that don't set config.github (the file isn't always
      // checked in). Either way, dutyMcp needs "owner/name" to hit the compare API.
      dutyRepoSlug:
        config.github?.owner && config.github?.repo
          ? `${config.github.owner}/${config.github.repo}`
          : process.env.GITHUB_REPOSITORY?.trim() || undefined,
      verifyToolMaxAttempts: profile.claudeCode.verifyAttempts ?? null,
      verifyConfig: profile.claudeCode.enableVerifyTool ? config : undefined,
      executableName: profileName,
      settingSources: (profile.claudeCode as { settingSources?: Array<"user" | "project" | "local"> }).settingSources,
    })
  }

  // Stash for checkCoverageWithRetry.
  ctx.data.__invokeAgent = invokeAgent

  try {
    // ── Preflight ────────────────────────────────────────────────────────────
    for (const entry of profile.scripts.preflight) {
      const preLabel = entry.script ?? entry.shell ?? "<unknown>"
      if (!shouldRun(entry, ctx)) {
        emitEvent(input.cwd, {
          executable: profileName,
          kind: "preflight",
          name: preLabel,
          outcome: "skipped",
        })
        continue
      }
      const t0 = Date.now()
      if (entry.shell) {
        await runShellEntry(entry, ctx, profile)
        // Shell entries record their outcome via postflight (recordOutcome →
        // saveTaskState → notifyTerminal → advanceFlow). Even on non-zero
        // exit, fall through so the state machine can advance — postflights
        // that should bail (commitAndPush, ensurePr, postIssueComment)
        // already check `ctx.skipAgent && exitCode !== undefined`.
        emitEvent(input.cwd, {
          executable: profileName,
          kind: "preflight",
          name: preLabel,
          durationMs: Date.now() - t0,
          outcome: ctx.output.exitCode && ctx.output.exitCode !== 0 ? "failed" : "ok",
        })
      } else {
        const fn = preflightScripts[entry.script!]
        if (!fn) return finishAndEnd({ exitCode: 99, reason: `preflight script not registered: ${entry.script}` })
        await fn(ctx, profile, entry.with)
        emitEvent(input.cwd, {
          executable: profileName,
          kind: "preflight",
          name: preLabel,
          durationMs: Date.now() - t0,
          outcome: ctx.skipAgent && ctx.output.exitCode && ctx.output.exitCode !== 0 ? "failed" : "ok",
        })
        if (ctx.skipAgent && ctx.output.exitCode !== undefined && ctx.output.exitCode !== 0) {
          // Hard bail from a TS preflight (e.g. uncommitted-changes refusal).
          return finishAndEnd(ctx.output)
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
        return finishAndEnd({
          exitCode: 99,
          reason: "composePrompt did not produce a prompt (ctx.data.prompt missing)",
        })
      }
      emitEvent(input.cwd, { executable: profileName, kind: "agent_start" })
      agentResult = await invokeAgent(prompt)
      emitEvent(input.cwd, {
        executable: profileName,
        kind: "agent_end",
        durationMs: agentResult.durationMs,
        outcome: agentResult.outcome === "completed" ? "ok" : "failed",
        meta: {
          kind: agentResult.outcomeKind,
          ...(agentResult.tokens ? { tokens: agentResult.tokens } : {}),
          ...(typeof agentResult.messageCount === "number" ? { messageCount: agentResult.messageCount } : {}),
          ...(agentResult.error ? { error: agentResult.error } : {}),
        },
      })
    }

    // ── Postflight ────────────────────────────────────────────────────────────
    // NOTE: postflights run unconditionally even after a preflight failure
    // (shell entries set ctx.skipAgent + non-zero exitCode but DO fall
    // through; only TS preflights with skipAgent + non-zero exit hard-bail
    // above). This is deliberate: postIssueComment, writeRunSummary,
    // recordOutcome, mirrorStateToPr, etc. need to fire on failure to
    // surface the failure to the user / state machine.
    //
    // The one exception is STATE-MUTATING postflights (commitAndPush,
    // ensurePr — see MUTATING_POSTFLIGHTS): the executor refuses to run them
    // whenever the run has already recorded a non-zero exit, from ANY source
    // (failed agent, failed preflight, or an earlier postflight like verify).
    // This makes failure-safety structural — a new mutating postflight that
    // forgets to self-guard can no longer commit a half-finished tree. The
    // scripts keep their own guards too, as defense-in-depth.
    for (const entry of profile.scripts.postflight) {
      const entryLabel = entry.script ?? entry.shell ?? "<unknown>"
      if (shouldBlockMutatingPostflight(entry.script, ctx.output.exitCode)) {
        // Preserve the downstream contract: consumers read commitResult.pushed /
        // .committed, so leave a definitive "nothing happened" marker — a
        // skipped commit must never be misread as a successful one.
        if (entry.script === "commitAndPush" && ctx.data.commitResult === undefined) {
          ctx.data.commitResult = {
            committed: false,
            pushed: false,
            skippedReason: `run already failed (exit ${ctx.output.exitCode}) — executor blocked ${entry.script}`,
          }
        }
        process.stderr.write(
          `[kody postflight] enforce-skip ${entryLabel}: run already failed (exit ${ctx.output.exitCode})\n`,
        )
        emitEvent(input.cwd, {
          executable: profileName,
          kind: "postflight",
          name: entryLabel,
          outcome: "skipped",
        })
        continue
      }
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
        emitEvent(input.cwd, {
          executable: profileName,
          kind: "postflight",
          name: entryLabel,
          outcome: "skipped",
        })
        continue
      }
      const label = entryLabel
      const t0 = Date.now()
      let postOutcome: "ok" | "failed" = "ok"
      try {
        if (entry.shell) {
          await runShellEntry(entry, ctx, profile)
        } else {
          const fn = postflightScripts[entry.script!]
          if (!fn) return finishAndEnd({ exitCode: 99, reason: `postflight script not registered: ${entry.script}` })
          await fn(ctx, profile, agentResult, entry.with)
        }
      } catch (err) {
        postOutcome = "failed"
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[kody] postflight "${label}" crashed: ${msg}\n`)
        // Phase 4h: persist a structured crash artifact so post-mortem
        // analysis isn't limited to stderr (which evaporates with the
        // GHA runner). Best-effort: failure to write the artifact must
        // not mask the original crash.
        try {
          const fsMod = await import("node:fs")
          const pathMod = await import("node:path")
          const { resolveRunId } = await import("./events.js")
          const runId = resolveRunId()
          const dir = pathMod.join(input.cwd, ".kody", "runs", runId, "crashes")
          fsMod.mkdirSync(dir, { recursive: true })
          const file = pathMod.join(dir, `${label.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.json`)
          fsMod.writeFileSync(
            file,
            JSON.stringify(
              {
                executable: profileName,
                postflight: label,
                message: msg,
                stack: err instanceof Error ? err.stack : undefined,
                ts: new Date().toISOString(),
              },
              null,
              2,
            ),
          )
        } catch {
          /* best effort */
        }
        // Accumulate reasons across cascading postflight crashes — the first
        // failure may not be the most informative one (e.g. ensurePr crash
        // followed by postIssueComment crash). Operators want every reason
        // visible, not just whichever one happened first.
        const summary = `postflight ${label} crashed: ${msg}`
        ctx.output.reason = ctx.output.reason ? `${ctx.output.reason}; ${summary}` : summary
        if (ctx.output.exitCode === 0) ctx.output.exitCode = 99
      }
      emitEvent(input.cwd, {
        executable: profileName,
        kind: "postflight",
        name: label,
        durationMs: Date.now() - t0,
        outcome: postOutcome,
      })
    }

    return finishAndEnd({
      exitCode: ctx.output.exitCode ?? 0,
      prUrl: ctx.output.prUrl,
      reason: ctx.output.reason,
      nextDispatch: ctx.output.nextDispatch,
    })
  } finally {
    // Clear any kody:* lifecycle labels stamped by `setLifecycleLabel`
    // preflight entries. Runs on every exit path (normal completion, hard
    // preflight bail, thrown exception) so labels never strand a PR/issue
    // outside the lifecycle taxonomy. Best-effort, never throws.
    clearStampedLifecycleLabels(profile, ctx)
    // Best-effort: warn if the agent didn't produce the per-task artifacts.
    // Missing artifacts never fail the task — this is observability only.
    if (taskArtifacts) {
      try {
        const missing = verifyTaskArtifacts(taskArtifacts.absDir)
        if (missing.length > 0) {
          process.stderr.write(`[task-artifacts] task ${taskArtifacts.taskId} missing: ${missing.join(", ")}\n`)
        }
      } catch {
        /* best effort */
      }
    }
    try {
      litellm?.kill()
    } catch {
      /* best effort */
    }
  }
}

/**
 * Hard ceiling on in-process stage hand-offs. Sits above the flow's own
 * FLOW_HOP_CAP (25 orchestrator↔child ping-pongs ≈ 50 hops, the real limiter
 * for flows); this only guards against a buggy stage that hands off forever.
 */
export const MAX_CHAIN_HOPS = 60

/**
 * Run an executable and follow any in-process stage hand-offs it requests via
 * `ctx.output.nextDispatch` (classify → build, a flow orchestrator↔child
 * ping-pong, goal-tick → the task pipeline). Each stage runs in the SAME
 * process, inheriting cwd/config/verbosity from `input` and overriding only
 * the cliArgs. This replaces the old `@kody <next>` comment round-trip, which
 * deadlocked when Kody comments as a GitHub App (the bot-authored comment is
 * silently ignored by the follow-up run). Both CLI entry points (the
 * event-driven `runCi` and the explicit-subcommand path in `entry.ts`) route
 * through here so hand-offs fire no matter how a stage was invoked.
 */
export async function runExecutableChain(profileName: string, input: ExecutorInput): Promise<ExecutorOutput> {
  let result = await runExecutable(profileName, input)
  for (let hops = 1; result.nextDispatch && hops <= MAX_CHAIN_HOPS; hops++) {
    const next = result.nextDispatch
    process.stdout.write(`→ kody: in-process hand-off → ${next.executable} (hop ${hops}/${MAX_CHAIN_HOPS})\n\n`)
    result = await runExecutable(next.executable, { ...input, cliArgs: next.cliArgs })
  }
  if (result.nextDispatch) {
    process.stderr.write(
      `[kody] in-process hand-off cap (${MAX_CHAIN_HOPS}) reached; not running ${result.nextDispatch.executable}\n`,
    )
  }
  return result
}

function clearStampedLifecycleLabels(profile: Profile, ctx: Context): void {
  const target = (ctx.args.issue ?? ctx.args.pr) as number | undefined
  if (typeof target !== "number" || !Number.isFinite(target)) return
  for (const entry of profile.scripts.preflight) {
    if (entry.script !== "setLifecycleLabel") continue
    const label = typeof entry.with?.label === "string" ? entry.with.label : undefined
    if (!label?.startsWith(KODY_NAMESPACE)) continue
    try {
      removeLabel(target, label, ctx.cwd)
    } catch {
      /* best effort */
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────

export function resolveProfilePath(profileName: string): string {
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

  // Pass positionals through verbatim — they're declared allowed above but
  // skipped by the per-spec coerce loop. Profiles that take subcommands
  // (e.g. `serve vscode`) read them from ctx.args._.
  if (Array.isArray(raw._)) {
    out._ = raw._
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
