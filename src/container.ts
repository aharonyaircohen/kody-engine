/**
 * Container loop. Runs children sequentially in-process, routing by each
 * child's `next` map over the action type emitted into state.core.lastOutcome.
 * Hard cap on iterations so a malformed routing table can't infinite-loop.
 *
 * Extracted from executor.ts: the executor stays the generic
 * preflight→agent→postflight runner; container orchestration (the only
 * multi-child shape) lives here. `runExecutable`/`resolveProfilePath` are
 * imported back from the executor — a runtime-only circular reference that
 * ESM resolves because both are hoisted function declarations called only
 * at run time, never during module evaluation.
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import { emitEvent } from "./events.js"
import type { ContainerChild, Context, InputSpec, Profile } from "./executables/types.js"
import { type ExecutorInput, type ExecutorOutput, resolveProfilePath, runExecutable } from "./executor.js"
import { loadProfile } from "./profile.js"
import { type Action, emptyState, readTaskState, type TaskState, type TaskTarget } from "./state.js"

const CONTAINER_MAX_ITERATIONS = 50

/**
 * Read the input specs of a child implementation's profile, returning null if the
 * profile can't be loaded. Used by the container loop to know which
 * parent-supplied args (e.g. `--base` from a parent dispatch) to
 * forward to the child without crashing the parent on profile-load errors.
 */
function getProfileInputsForChild(profileName: string, _cwd: string): InputSpec[] | null {
  try {
    const profilePath = resolveProfilePath(profileName)
    if (!fs.existsSync(profilePath)) return null
    return loadProfile(profilePath).inputs
  } catch {
    return null
  }
}

export async function runContainerLoop(profile: Profile, ctx: Context, input: ExecutorInput): Promise<void> {
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

  // Phase 5 in-process handoff: when `preloadContext: true`, run the
  // shared context loaders ONCE at container start and pass the
  // resulting snapshot to every child. Each child's loaders take their
  // fast path and skip the redundant GH/filesystem round-trips. The
  // container's own preflight already loaded `issue` and `taskState`
  // via its declared preflight chain; here we top up the remaining
  // four loaders (conventions, priorArt, memoryContext, coverageRules)
  // against the container's ctx so the snapshot is complete.
  let preloadedSnapshot: Record<string, unknown> | undefined
  if (profile.preloadContext) {
    try {
      const { loadConventions } = await import("./scripts/loadConventions.js")
      const { loadPriorArt } = await import("./scripts/loadPriorArt.js")
      const { loadMemoryContext } = await import("./scripts/loadMemoryContext.js")
      const { loadCoverageRules } = await import("./scripts/loadCoverageRules.js")
      await loadConventions(ctx, profile)
      await loadPriorArt(ctx, profile)
      await loadMemoryContext(ctx, profile)
      await loadCoverageRules(ctx, profile)
      preloadedSnapshot = {}
      // Only forward keys the children's loaders know how to fast-path on.
      // Forwarding the entire ctx.data would also carry container-private
      // bookkeeping (lifecycleLabelsSet, etc.) which children shouldn't see.
      for (const k of ["issue", "conventions", "priorArt", "memoryContext", "coverageRules", "taskContext"]) {
        if (ctx.data[k] !== undefined) preloadedSnapshot[k] = ctx.data[k]
      }
      process.stderr.write(
        `[kody container] preloadContext: snapshot keys=${Object.keys(preloadedSnapshot).join(",")}\n`,
      )
    } catch (err) {
      // Pre-loading must never wedge the flow. On failure, fall back to
      // legacy behaviour (each child re-loads).
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody container] preloadContext failed (falling back to per-child loads): ${msg}\n`)
      preloadedSnapshot = undefined
    }
  }

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
    // would otherwise interfere with the next child's branch operations.
    // Surfaced on A-Guy issue #1440: plan succeeded, run started on a
    // dirty tree — a hard reset is a deterministic recovery. Untracked
    // files are left alone (preserving node_modules, pip caches, etc.).
    // Best-effort: failures don't abort.
    //
    // Opt-out: profiles can set `resetBetweenChildren: false` when their
    // children deliberately share intermediate state (e.g. bug's
    // `reproduce` writes a failing test that `run` then makes pass).
    if (profile.resetBetweenChildren !== false) {
      resetWorkingTree(input.cwd)
    } else {
      process.stderr.write(`[kody container] resetBetweenChildren=false; preserving tracked tree\n`)
    }

    // Idempotency: if state already shows a *_COMPLETED action for this child,
    // skip the invocation and use the stored outcome to route. Lets a
    // re-invoked container resume from where the prior run left off without
    // re-doing committed work (e.g. a plan that already produced an artifact).
    const priorState = readContainerState(ctx, child, reader)
    if (priorState.core?.prUrl) knownPrUrl = priorState.core.prUrl
    const priorAction = priorState.implementations?.[child.exec]?.lastAction
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

      // Forward any parent-supplied args the child profile declares but
      // that container's target-derivation doesn't already inject. Without
      // this, comment-supplied flags like `@kody --base <branch>` are
      // silently dropped between the container (e.g. chore/feature/fix/bug)
      // run primitive.
      const childInputs = getProfileInputsForChild(child.exec, input.cwd)
      if (childInputs) {
        for (const spec of childInputs) {
          if (spec.name === "issue" || spec.name === "pr") continue
          const parentValue = ctx.args[spec.name]
          if (parentValue !== undefined && cliArgs[spec.name] === undefined) {
            cliArgs[spec.name] = parentValue
          }
        }
      }

      let childOut: ExecutorOutput
      const childStartedAt = Date.now()
      // Mark the child as running under a container parent so postflights
      // that gate user-facing messages (postIssueComment, finishFlow) can
      // distinguish "this is a final terminal state" from "an intermediate
      // child result that the container will route past". The parent name
      // gives postflights enough context to format informational messages
      // without pretending to own the flow's terminal state. Cleared in
      // finally so a child crash doesn't leak the marker across iterations
      // or beyond the loop.
      const priorParent = process.env.KODY_CONTAINER_PARENT
      process.env.KODY_CONTAINER_PARENT = profile.name
      try {
        childOut = await runChild(child.exec, {
          cliArgs,
          cwd: input.cwd,
          config: input.config,
          skipConfig: input.skipConfig,
          verbose: input.verbose,
          quiet: input.quiet,
          // Phase 5 in-process handoff — undefined when preloadContext
          // is off, so children fall back to their own loaders.
          preloadedData: preloadedSnapshot,
        })
        emitEvent(input.cwd, {
          executable: profile.name,
          kind: "container_child",
          name: child.exec,
          durationMs: Date.now() - childStartedAt,
          outcome: childOut.exitCode === 0 ? "ok" : "failed",
          meta: { exitCode: childOut.exitCode, iteration },
        })
      } catch (err) {
        emitEvent(input.cwd, {
          executable: profile.name,
          kind: "container_child",
          name: child.exec,
          durationMs: Date.now() - childStartedAt,
          outcome: "failed",
          meta: { iteration, error: err instanceof Error ? err.message : String(err) },
        })
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[kody container] child "${child.exec}" crashed: ${msg}\n`)
        ctx.output.exitCode = 1
        ctx.output.reason = `child "${child.exec}" crashed: ${msg}`
        return
      } finally {
        if (priorParent === undefined) delete process.env.KODY_CONTAINER_PARENT
        else process.env.KODY_CONTAINER_PARENT = priorParent
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
      // When the child bailed before saveTaskState (e.g. a non-zero exit
      // from a preflight script — historically runFlow's now-removed
      // uncommitted-changes refusal on A-Guy issue #1440), the counter
      // is unchanged and we synthesize <EXEC>_COMPLETED|FAILED from the
      // exit code so finishFlow's runWhens can match the actual outcome
      // instead of leaking the prior child's action.
      const priorAttempts = priorState.core?.attempts?.[child.exec] ?? 0
      const next = readContainerState(ctx, child, reader)
      if (next.core?.prUrl) knownPrUrl = next.core.prUrl
      const nextAttempts = next.core?.attempts?.[child.exec] ?? 0
      const nextChildAction = next.implementations?.[child.exec]?.lastAction
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
            currentImplementation: null,
            lastOutcome: synthetic,
            // Bump attempts here too — a synthesized action is, semantically,
            // a saveTaskState write that just didn't happen mechanically.
            // Without this, the dashboard's `attempts[child]` view shows
            // "never run" forever whenever a flaky preflight always bails.
            attempts: { [child.exec]: priorAttempts + 1 },
          }
        } else {
          next.core.lastOutcome = synthetic
          next.core.attempts = {
            ...next.core.attempts,
            [child.exec]: priorAttempts + 1,
          }
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
 * Each child writes its outcome to task state for whatever target it
 * ran against (saveTaskState reads `ctx.data.commentTargetType`). A child
 * with `target: "pr"` therefore writes its action to the PR's state file,
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
  return emptyState()
}

function parsePrNumber(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : null
}
