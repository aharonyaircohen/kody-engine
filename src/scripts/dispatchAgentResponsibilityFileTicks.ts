/**
 * Preflight: enumerate `.kody/agent-responsibilities/<slug>/` folders in the cwd, then
 * invoke a target agentAction once per agentResponsibility slug (in-process, sequentially).
 *
 * Replaces the issue-label discovery in `dispatchAgentResponsibilityTicks` with folder
 * discovery — agentResponsibilities live as structured repo folders, not as issues.
 *
 * Wraps the fan-out in the configured `JobStateBackend` lifecycle:
 * `hydrate` runs once before any tick, `persist` runs once after every
 * tick (even on failure, in a finally block). Backends that are always
 * live (contents-API) leave both as no-ops; backends that snapshot the
 * agentResponsibility directory (local-file + Actions cache) implement them.
 *
 * Script args (via `with:`):
 *   jobsDir        optional — relative path under cwd (default ".kody/agent-responsibilities")
 *   targetAgentAction   required — e.g. "agent-responsibility-tick"
 *   scriptedAgentAction optional — target for slugs with `tickScript`
 *                      in profile.json (default "agent-responsibility-tick-scripted")
 *   slugArg            optional — CLI input name on the target (default "agentResponsibility")
 */

import * as path from "node:path"
import { type AgentResponsibilityFolder, listAgentResponsibilityFolderSlugs } from "../agent-responsibilityFolders.js"
import type { PreflightScript } from "../agent-actions/types.js"
import { gh } from "../issue.js"
import { mintScheduledJob, runJob } from "../job.js"
import { getCompanyStoreAgentResponsibilitiesRoot, resolveAgentResponsibilityFolder } from "../registry.js"
import { resolveBackend } from "./jobState/index.js"
import { TASK_JOBS_MARKER } from "./planTaskJobs.js"
import { type ScheduleEvery, scheduleEveryToMs } from "./scheduleEvery.js"

export const dispatchAgentResponsibilityFileTicks: PreflightScript = async (ctx, _profile, args) => {
  ctx.skipAgent = true

  const targetAgentAction = String(args?.targetAgentAction ?? "")
  if (!targetAgentAction) {
    throw new Error("dispatchAgentResponsibilityFileTicks: `with.targetAgentAction` is required")
  }
  const jobsDir = String(args?.jobsDir ?? ".kody/agent-responsibilities")
  const scriptedAgentAction = String(args?.scriptedAgentAction ?? "agent-responsibility-tick-scripted")
  const slugArg = String(args?.slugArg ?? "agentResponsibility")

  // Resolve once, hydrate once, persist once. Per-tick scripts re-resolve
  // for their own load/save calls — backends are cheap to construct, but
  // hydrate/persist must happen exactly once per workflow run.
  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  if (backend.hydrate) {
    await backend.hydrate()
  }

  try {
    const onlyAgentResponsibility = parseAgentResponsibilityFilter(ctx.args.agentResponsibility)
    if (args?.requireExplicitAgentResponsibility === true && !onlyAgentResponsibility) {
      ctx.output.exitCode = 0
      ctx.output.reason = "scheduled agentResponsibility fan-out is owned by goal-scheduler"
      process.stdout.write("[jobs] no flat agentResponsibility fan-out; goal-scheduler owns scheduled agentResponsibility decisions\n")
      return
    }
    const jobsPath = path.join(ctx.cwd, jobsDir)
    const storeJobsPath = getCompanyStoreAgentResponsibilitiesRoot()
    const slugs = filterSlugs(
      listActivatedAgentResponsibilitySlugs(jobsPath, storeJobsPath, ctx.config.company?.activeAgentResponsibilities),
      onlyAgentResponsibility,
    )
    ctx.data.jobSlugCount = slugs.length

    if (slugs.length === 0) {
      const filter = onlyAgentResponsibility ? ` matching ${onlyAgentResponsibility}` : ""
      process.stdout.write(`[jobs] no agentResponsibility folders${filter} in ${jobsDir}\n`)
      return
    }

    const filtered = onlyAgentResponsibility ? ` matching ${onlyAgentResponsibility}` : ""
    process.stdout.write(`[jobs] ticking ${slugs.length} agent responsibility/ies${filtered} via ${targetAgentAction}\n`)

    const results: Array<{
      slug: string
      exitCode: number
      reason?: string
      skipped?: boolean
    }> = []
    const now = Date.now()

    for (const slug of slugs) {
      const agentResponsibility = resolveAgentResponsibilityFolder(slug, jobsPath)
      if (!agentResponsibility) {
        process.stderr.write(`[jobs] ⏭  skip ${slug}: agentResponsibility folder is missing profile.json or agent-responsibility.md\n`)
        results.push({ slug, exitCode: 0, skipped: true, reason: "incomplete agentResponsibility folder" })
        continue
      }
      const config = agentResponsibility.config

      // Hard kill-switch — when the dashboard's enable/disable toggle
      // flips a job off, the profile carries `disabled: true`. Skip
      // before cadence math so a disabled job never re-arms its
      // lastFiredAt or churns state. Manual `workflow_dispatch` runs
      // (the dashboard "Run now" button) bypass this dispatcher entirely.
      if (config.disabled === true) {
        process.stdout.write(`[jobs] ⏭  skip ${slug}: disabled in profile.json\n`)
        results.push({ slug, exitCode: 0, skipped: true, reason: "disabled" })
        continue
      }

      // Every agentResponsibility must name an executor. The agent is the agent
      // the tick runs as; with none declared there's no identity to run, so
      // skip (loudly) rather than fall back to an implicit default. Manual
      // `workflow_dispatch` "Run now" bypasses this dispatcher, but
      // agent-responsibility-tick's loader rejects a missing/dangling agent there too.
      if (!config.agent || config.agent.trim().length === 0) {
        process.stderr.write(`[jobs] ⏭  skip ${slug}: no agent assigned (add "agent" to profile.json)\n`)
        results.push({ slug, exitCode: 0, skipped: true, reason: "no agent assigned" })
        continue
      }

      // Decide whether this slug is due, given its profile `every` and
      // the previously persisted `data.lastFiredAt`. Jobs without a
      // schedule (or with a malformed one) tick every wake — preserves
      // legacy behavior.
      const decision = await decideShouldFire(config.every, slug, backend, now)
      if (decision.skip) {
        process.stdout.write(`[jobs] ⏭  skip ${slug}: ${decision.reason}\n`)
        results.push({ slug, exitCode: 0, skipped: true, reason: decision.reason })
        continue
      }

      if (config.agentActions && config.agentActions.length > 0) {
        try {
          const task = createAgentResponsibilityTaskIssue({
            slug,
            body: agentResponsibility.body,
            config,
            cwd: ctx.cwd,
          })
          await stampFired(backend, slug, now, task)
          process.stdout.write(`[jobs] → run ${slug} multi-agentAction task #${task.number} (task-jobs)\n`)
          const out = await runJob(
            mintScheduledJob({
              agentResponsibility: slug,
              agentAction: "task-jobs",
              schedule: config.every,
              agent: config.agent,
              cliArgs: { issue: task.number },
            }),
            { cwd: ctx.cwd, config: ctx.config, verbose: ctx.verbose, quiet: ctx.quiet },
          )
          results.push({ slug, exitCode: out.exitCode, reason: out.reason })
          if (out.exitCode !== 0) {
            process.stderr.write(`[jobs] task ${slug} failed (exit ${out.exitCode}): ${out.reason ?? ""}\n`)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          process.stderr.write(`[jobs] task ${slug} crashed: ${msg}\n`)
          results.push({ slug, exitCode: 99, reason: msg })
        }
        continue
      }

      // Per-slug routing: agentResponsibilities that declare a deterministic `tickScript`
      // in profile.json run via `agent-responsibility-tick-scripted` (no agent), so their
      // next-state block is parsed from script stdout — not from an LLM
      // that may summarize it away. Everything else uses the configured
      // (LLM-driven) target. Decided here, not in the agentAction, so the
      // routing rule lives in one place and the agentActions stay simple.
      const slugTarget = config.tickScript ? scriptedAgentAction : (config.agentAction ?? targetAgentAction)
      const cliArgs = config.agentAction && !config.tickScript ? {} : { [slugArg]: slug }

      process.stdout.write(`[jobs] → tick ${slug} (${slugTarget})\n`)
      try {
        // One-runner: a due agentResponsibility folder becomes a scheduled Job, run via runJob
        // with chain:false → byte-identical to the prior one-shot runAgentAction.
        const out = await runJob(
          mintScheduledJob({
            agentResponsibility: slug,
            agentAction: slugTarget,
            schedule: config.every,
            agent: config.agent,
            cliArgs,
          }),
          { cwd: ctx.cwd, config: ctx.config, verbose: ctx.verbose, quiet: ctx.quiet, chain: false },
        )
        results.push({ slug, exitCode: out.exitCode, reason: out.reason })
        if (out.exitCode !== 0) {
          process.stderr.write(`[jobs] tick ${slug} failed (exit ${out.exitCode}): ${out.reason ?? ""}\n`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[jobs] tick ${slug} crashed: ${msg}\n`)
        results.push({ slug, exitCode: 99, reason: msg })
      }
    }

    ctx.data.jobTickResults = results
    // Scheduler always exits 0 — individual tick failures are reported per-slug
    // in stderr but don't fail the cron job.
    ctx.output.exitCode = 0
  } finally {
    // Always persist, even when fan-out crashed: backends that snapshot to
    // external stores (Actions cache) need the latest disk state captured
    // regardless of why the run is ending.
    if (backend.persist) {
      try {
        await backend.persist()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[jobs] backend persist failed: ${msg}\n`)
      }
    }
  }
}

/**
 * Decide whether a slug is due to tick on this cron wake. AgentResponsibilities with no
 * `every` profile field always tick. AgentResponsibilities with one are
 * skipped when their last `lastFiredAt` is more recent than the
 * cadence allows.
 *
 * The profile is read once per slug by the caller and the pre-parsed `every`
 * is passed in. State load failures fall
 * through to "fire" — we'd rather double-tick once than silently swallow
 * a job whose state file is malformed.
 */
async function decideShouldFire(
  every: ScheduleEvery | undefined,
  slug: string,
  backend: ReturnType<typeof resolveBackend>,
  now: number,
): Promise<{ skip: boolean; reason: string }> {
  if (!every) return { skip: false, reason: "no schedule (every cron tick)" }
  if (every === "manual") {
    return { skip: true, reason: "manual-only (no auto-fire; trigger via dashboard Run now)" }
  }

  let lastFiredAt: number | null = null
  try {
    const loaded = await backend.load(slug)
    const raw = loaded.state.data?.lastFiredAt
    if (typeof raw === "string") {
      const ms = Date.parse(raw)
      if (!Number.isNaN(ms)) lastFiredAt = ms
    }
  } catch {
    // Treat load failure as "fire it" — a missing state file just means
    // the job has never run.
    return { skip: false, reason: "state unreadable; firing" }
  }

  if (lastFiredAt === null) {
    return { skip: false, reason: `first tick (every ${every})` }
  }

  const intervalMs = scheduleEveryToMs(every)
  const elapsedMs = now - lastFiredAt
  if (elapsedMs >= intervalMs) {
    return { skip: false, reason: `due (every ${every}, last ${formatAgo(elapsedMs)} ago)` }
  }
  const remainingMs = intervalMs - elapsedMs
  return {
    skip: true,
    reason: `every ${every}; ${formatAgo(elapsedMs)} since last tick, next in ${formatAgo(remainingMs)}`,
  }
}

function formatAgo(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr}h`
  const day = Math.round(hr / 24)
  return `${day}d`
}

function parseAgentResponsibilityFilter(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined
}

function filterSlugs(slugs: string[], onlyAgentResponsibility: string | undefined): string[] {
  return onlyAgentResponsibility ? slugs.filter((slug) => slug === onlyAgentResponsibility) : slugs
}

function listActivatedAgentResponsibilitySlugs(
  projectRoot: string,
  storeRoot: string | null,
  activeStoreAgentResponsibilities: string[] | undefined,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const slug of listAgentResponsibilityFolderSlugs(projectRoot)) {
    if (seen.has(slug)) continue
    seen.add(slug)
    out.push(slug)
  }
  const active = new Set(activeStoreAgentResponsibilities ?? [])
  if (storeRoot && active.size > 0) {
    for (const slug of listAgentResponsibilityFolderSlugs(storeRoot)) {
      if (!active.has(slug) || seen.has(slug)) continue
      seen.add(slug)
      out.push(slug)
    }
  }
  return out.sort()
}

interface AgentResponsibilityTaskIssue {
  number: number
  url: string
}

function createAgentResponsibilityTaskIssue(opts: {
  slug: string
  body: string
  config: AgentResponsibilityFolder["config"]
  cwd: string
}): AgentResponsibilityTaskIssue {
  const title = `AgentResponsibility ${opts.slug} - multi-agentAction task`
  const body = buildAgentResponsibilityTaskIssueBody(opts.slug, opts.body, opts.config)
  const out = gh(["issue", "create", "--title", title, "--body-file", "-"], { input: body, cwd: opts.cwd })
  const url =
    out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? ""
  const match = url.match(/\/issues\/(\d+)\b/)
  if (!match) throw new Error(`gh issue create returned unexpected output: ${out}`)
  return { number: Number(match[1]), url }
}

function buildAgentResponsibilityTaskIssueBody(slug: string, agentResponsibilityBody: string, config: AgentResponsibilityFolder["config"]): string {
  const specs = (config.agentActions ?? []).map((agentAction) => ({
    agentAction,
    agentResponsibility: slug,
    ...(config.agent ? { agent: config.agent } : {}),
    reason: `AgentResponsibility \`${slug}\` slice for \`${agentAction}\`.`,
    flavor: "scheduled",
    ...(config.every ? { schedule: config.every } : {}),
  }))
  return [
    `# AgentResponsibility task: ${slug}`,
    "",
    agentResponsibilityBody.trim() || "(no agentResponsibility body)",
    "",
    `<!-- ${TASK_JOBS_MARKER}`,
    JSON.stringify(specs, null, 2),
    "-->",
    "",
  ].join("\n")
}

/** Persist `lastFiredAt = now` for a scheduled folder-agentResponsibility (no agent-responsibility-tick to do it). */
async function stampFired(
  backend: ReturnType<typeof resolveBackend>,
  slug: string,
  now: number,
  task?: AgentResponsibilityTaskIssue,
): Promise<void> {
  try {
    const loaded = await backend.load(slug)
    const nextData = {
      ...(loaded.state.data ?? {}),
      lastFiredAt: new Date(now).toISOString(),
      ...(task ? { lastTaskIssue: task.number, lastTaskUrl: task.url } : {}),
    }
    await backend.save(loaded, { ...loaded.state, data: nextData })
  } catch (err) {
    process.stderr.write(`[jobs] failed to stamp lastFiredAt for ${slug}: ${String(err)}\n`)
  }
}
