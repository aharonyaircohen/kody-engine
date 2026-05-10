/**
 * Preflight: enumerate `.kody/jobs/<slug>.md` files in the cwd, then
 * invoke a target executable once per job slug (in-process, sequentially).
 *
 * Replaces the issue-label discovery in `dispatchJobTicks` with file
 * discovery — jobs live as authored markdown in the repo, not as issues.
 *
 * Wraps the fan-out in the configured `JobStateBackend` lifecycle:
 * `hydrate` runs once before any tick, `persist` runs once after every
 * tick (even on failure, in a finally block). Backends that are always
 * live (contents-API) leave both as no-ops; backends that snapshot the
 * job directory (local-file + Actions cache) implement them.
 *
 * Script args (via `with:`):
 *   jobsDir        optional — relative path under cwd (default ".kody/jobs")
 *   targetExecutable   required — e.g. "job-tick"
 *   slugArg            optional — CLI input name on the target (default "job")
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"
import { runExecutable } from "../executor.js"
import { type ScheduleEvery, scheduleEveryToMs, splitFrontmatter } from "./jobFrontmatter.js"
import { resolveBackend } from "./jobState/index.js"

export const dispatchJobFileTicks: PreflightScript = async (ctx, _profile, args) => {
  ctx.skipAgent = true

  const targetExecutable = String(args?.targetExecutable ?? "")
  if (!targetExecutable) {
    throw new Error("dispatchJobFileTicks: `with.targetExecutable` is required")
  }
  const jobsDir = String(args?.jobsDir ?? ".kody/jobs")
  const slugArg = String(args?.slugArg ?? "job")

  // Resolve once, hydrate once, persist once. Per-tick scripts re-resolve
  // for their own load/save calls — backends are cheap to construct, but
  // hydrate/persist must happen exactly once per workflow run.
  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  if (backend.hydrate) {
    await backend.hydrate()
  }

  try {
    const slugs = listJobSlugs(path.join(ctx.cwd, jobsDir))
    ctx.data.jobSlugCount = slugs.length

    if (slugs.length === 0) {
      process.stdout.write(`[jobs] no job files in ${jobsDir}\n`)
      return
    }

    process.stdout.write(`[jobs] ticking ${slugs.length} job(s) via ${targetExecutable}\n`)

    const results: Array<{
      slug: string
      exitCode: number
      reason?: string
      skipped?: boolean
    }> = []
    const now = Date.now()
    for (const slug of slugs) {
      // Decide whether this slug is due, given its frontmatter `every` and
      // the previously persisted `data.lastFiredAt`. Jobs without a
      // schedule (or with a malformed one) tick every wake — preserves
      // legacy behavior.
      const decision = await decideShouldFire(ctx.cwd, jobsDir, slug, backend, now)
      if (decision.skip) {
        process.stdout.write(`[jobs] ⏭  skip ${slug}: ${decision.reason}\n`)
        results.push({ slug, exitCode: 0, skipped: true, reason: decision.reason })
        continue
      }

      // Per-slug routing: jobs that declare a deterministic `tickScript:`
      // in frontmatter run via `job-tick-scripted` (no agent), so their
      // next-state block is parsed from script stdout — not from an LLM
      // that may summarize it away. Everything else uses the configured
      // (LLM-driven) target. Decided here, not in the executable, so the
      // routing rule lives in one place and the executables stay simple.
      const slugTarget = readTickScript(ctx.cwd, jobsDir, slug) ? "job-tick-scripted" : targetExecutable

      process.stdout.write(`[jobs] → tick ${slug} (${slugTarget})\n`)
      try {
        const out = await runExecutable(slugTarget, {
          cliArgs: { [slugArg]: slug },
          cwd: ctx.cwd,
          config: ctx.config,
          verbose: ctx.verbose,
          quiet: ctx.quiet,
        })
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
 * Decide whether a slug is due to tick on this cron wake. Jobs with no
 * `every:` frontmatter always tick (legacy default). Jobs with one are
 * skipped when their last `lastFiredAt` is more recent than the
 * cadence allows.
 *
 * Reads the .md off disk for frontmatter, then loads state via the
 * shared backend. Errors fall through to "fire" — we'd rather double-
 * tick once than silently swallow a job whose state file is malformed.
 */
async function decideShouldFire(
  cwd: string,
  jobsDir: string,
  slug: string,
  backend: ReturnType<typeof resolveBackend>,
  now: number,
): Promise<{ skip: boolean; reason: string }> {
  let every: ScheduleEvery | undefined
  try {
    const raw = fs.readFileSync(path.join(cwd, jobsDir, `${slug}.md`), "utf-8")
    every = splitFrontmatter(raw).frontmatter.every
  } catch {
    return { skip: false, reason: "frontmatter unreadable" }
  }
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

/**
 * Cheap-and-tolerant frontmatter peek used by per-slug routing.
 * Returns the raw `tickScript:` value when present, or null otherwise
 * (including when the file is missing/unreadable — caller falls back
 * to the default LLM-driven target).
 */
function readTickScript(cwd: string, jobsDir: string, slug: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(cwd, jobsDir, `${slug}.md`), "utf-8")
    return splitFrontmatter(raw).frontmatter.tickScript ?? null
  } catch {
    return null
  }
}

function listJobSlugs(absDir: string): string[] {
  if (!fs.existsSync(absDir)) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name.replace(/\.md$/, ""))
    .filter((slug) => slug.length > 0 && !slug.startsWith("_") && !slug.startsWith("."))
    .sort()
}
