/**
 * Preflight: enumerate `.kody/duties/<slug>.md` files in the cwd, then
 * invoke a target executable once per duty slug (in-process, sequentially).
 *
 * Replaces the issue-label discovery in `dispatchDutyTicks` with file
 * discovery — duties live as authored markdown in the repo, not as issues.
 *
 * Wraps the fan-out in the configured `JobStateBackend` lifecycle:
 * `hydrate` runs once before any tick, `persist` runs once after every
 * tick (even on failure, in a finally block). Backends that are always
 * live (contents-API) leave both as no-ops; backends that snapshot the
 * duty directory (local-file + Actions cache) implement them.
 *
 * Script args (via `with:`):
 *   jobsDir        optional — relative path under cwd (default ".kody/duties")
 *   targetExecutable   required — e.g. "duty-tick"
 *   scriptedExecutable optional — target for slugs with `tickScript:`
 *                      frontmatter (default "duty-tick-scripted")
 *   slugArg            optional — CLI input name on the target (default "duty")
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"
import { mintScheduledJob, runJob } from "../job.js"
import { loadProfile } from "../profile.js"
import { type ScheduleEvery, scheduleEveryToMs, splitFrontmatter } from "./jobFrontmatter.js"
import { resolveBackend } from "./jobState/index.js"

export const dispatchDutyFileTicks: PreflightScript = async (ctx, _profile, args) => {
  ctx.skipAgent = true

  const targetExecutable = String(args?.targetExecutable ?? "")
  if (!targetExecutable) {
    throw new Error("dispatchDutyFileTicks: `with.targetExecutable` is required")
  }
  const jobsDir = String(args?.jobsDir ?? ".kody/duties")
  const scriptedExecutable = String(args?.scriptedExecutable ?? "duty-tick-scripted")
  const slugArg = String(args?.slugArg ?? "duty")

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
      process.stdout.write(`[duties] no duty files in ${jobsDir}\n`)
      return
    }

    process.stdout.write(`[duties] ticking ${slugs.length} dut(y/ies) via ${targetExecutable}\n`)

    const results: Array<{
      slug: string
      exitCode: number
      reason?: string
      skipped?: boolean
    }> = []
    const now = Date.now()

    // ── Unified path: scheduled folder-duties — FIRST, on the clean checkout ──
    // A folder-duty (`.kody/duties/<slug>/profile.json`) that declares an
    // `every` cadence is the unified successor to a markdown scheduled duty: it
    // fires as a ONE-SHOT run of itself (no duty-tick, no target), as its staff.
    // We enumerate + read profiles HERE, before the `.md` ticks below churn the
    // working tree (a branch switch / clean would drop `.kody/duties/<slug>/`),
    // then fire the due ones. On-demand folder-duties (no `every`) are skipped —
    // they only run against an issue/PR. Cadence reuses decideShouldFire + the
    // same backend; lastFiredAt is stamped before running so a crashing duty
    // can't re-fire every wake.
    type ScheduledDuty = { slug: string; every?: string; staff?: string }
    // Every folder-duty slug present this wake. A migrated duty lives as a
    // folder (`.kody/duties/<slug>/`); if a stale `.kody/duties/<slug>.md`
    // still exists for the same slug, the folder wins and the .md tick is
    // skipped below — otherwise the slug would fire twice in one wake.
    const folderSlugList = listFolderDutySlugs(path.join(ctx.cwd, jobsDir))
    const folderDutySlugs = new Set(folderSlugList)
    const scheduledDuties = folderSlugList
      .map((slug): ScheduledDuty | null => {
        try {
          const p = loadProfile(path.join(ctx.cwd, jobsDir, slug, "profile.json"))
          return { slug, every: p.every, staff: p.staff }
        } catch (err) {
          process.stderr.write(`[duties] ⏭  skip folder-duty ${slug}: profile load failed: ${String(err)}\n`)
          return null
        }
      })
      .filter((d): d is ScheduledDuty => d !== null && Boolean(d.every))
    process.stdout.write(`[duties] ${scheduledDuties.length} scheduled folder-dut(y/ies) to consider\n`)
    for (const { slug, every, staff } of scheduledDuties) {
      if (!staff || staff.trim().length === 0) {
        process.stderr.write(`[duties] ⏭  skip ${slug}: scheduled duty has no staff\n`)
        results.push({ slug, exitCode: 0, skipped: true, reason: "no staff assigned" })
        continue
      }
      const decision = await decideShouldFire(every as ScheduleEvery, slug, backend, now)
      if (decision.skip) {
        process.stdout.write(`[duties] ⏭  skip ${slug}: ${decision.reason}\n`)
        results.push({ slug, exitCode: 0, skipped: true, reason: decision.reason })
        continue
      }
      await stampFired(backend, slug, now)
      process.stdout.write(`[duties] → run scheduled duty ${slug} (one-shot, as ${staff})\n`)
      try {
        // One-runner: a due folder-duty becomes a scheduled Job, run via runJob
        // with chain:false → the same one-shot runExecutable call as before
        // (no persona/why seeded, so the ExecutorInput is byte-identical).
        const out = await runJob(mintScheduledJob({ duty: slug, executable: slug, schedule: every }), {
          cwd: ctx.cwd,
          config: ctx.config,
          verbose: ctx.verbose,
          quiet: ctx.quiet,
          chain: false,
        })
        results.push({ slug, exitCode: out.exitCode, reason: out.reason })
        if (out.exitCode !== 0) {
          process.stderr.write(`[duties] scheduled duty ${slug} failed (exit ${out.exitCode}): ${out.reason ?? ""}\n`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[duties] scheduled duty ${slug} crashed: ${msg}\n`)
        results.push({ slug, exitCode: 99, reason: msg })
      }
    }

    for (const slug of slugs) {
      // Dedup: a slug that already exists as a folder-duty is handled above —
      // never also tick its legacy `.md` (would double-fire / duplicate output).
      if (folderDutySlugs.has(slug)) {
        // Deprecation nudge: the markdown sibling is shadowed by the folder
        // duty. The folder wins by design (one tick per slug per wake), but
        // the user-visible `duty / .md` shape is the legacy form. Surface the
        // collision so the user can migrate or remove the orphan. One log per
        // shadowed slug per tick — the loop visits each shadowed slug at most
        // once, so the nudge fires at most once per slug per tick.
        process.stdout.write(
          `[duties] markdown duty '${slug}' is shadowed by folder duty; migrate or remove\n`,
        )
        results.push({ slug, exitCode: 0, skipped: true, reason: "handled as folder-duty" })
        continue
      }
      // Read the slug's frontmatter exactly once per tick — both the
      // cadence guard (`every:`) and the routing rule (`tickScript:`)
      // consume it. A previous version parsed the file twice; folded
      // here to keep the dispatcher cheap on repos with many jobs.
      const frontmatter = readJobFrontmatter(ctx.cwd, jobsDir, slug)

      // Hard kill-switch — when the dashboard's enable/disable toggle
      // flips a job off, the frontmatter carries `disabled: true`. Skip
      // before cadence math so a disabled job never re-arms its
      // lastFiredAt or churns state. Manual `workflow_dispatch` runs
      // (the dashboard "Run now" button) bypass this dispatcher entirely.
      if (frontmatter.disabled === true) {
        process.stdout.write(`[duties] ⏭  skip ${slug}: disabled in frontmatter\n`)
        results.push({ slug, exitCode: 0, skipped: true, reason: "disabled" })
        continue
      }

      // Every duty must name an executor. The staff member is the persona
      // the tick runs as; with none declared there's no identity to run, so
      // skip (loudly) rather than fall back to an implicit default. Manual
      // `workflow_dispatch` "Run now" bypasses this dispatcher, but
      // duty-tick's loader rejects a missing/dangling staff member there too.
      if (!frontmatter.staff || frontmatter.staff.trim().length === 0) {
        process.stderr.write(`[duties] ⏭  skip ${slug}: no staff assigned (add 'staff: <slug>' frontmatter)\n`)
        results.push({ slug, exitCode: 0, skipped: true, reason: "no staff assigned" })
        continue
      }

      // Decide whether this slug is due, given its frontmatter `every` and
      // the previously persisted `data.lastFiredAt`. Jobs without a
      // schedule (or with a malformed one) tick every wake — preserves
      // legacy behavior.
      const decision = await decideShouldFire(frontmatter.every, slug, backend, now)
      if (decision.skip) {
        process.stdout.write(`[duties] ⏭  skip ${slug}: ${decision.reason}\n`)
        results.push({ slug, exitCode: 0, skipped: true, reason: decision.reason })
        continue
      }

      // Per-slug routing: jobs that declare a deterministic `tickScript:`
      // in frontmatter run via `duty-tick-scripted` (no agent), so their
      // next-state block is parsed from script stdout — not from an LLM
      // that may summarize it away. Everything else uses the configured
      // (LLM-driven) target. Decided here, not in the executable, so the
      // routing rule lives in one place and the executables stay simple.
      const slugTarget = frontmatter.tickScript ? scriptedExecutable : targetExecutable

      process.stdout.write(`[duties] → tick ${slug} (${slugTarget})\n`)
      try {
        // One-runner: a due .md duty becomes a scheduled Job, run via runJob
        // with chain:false → byte-identical to the prior one-shot runExecutable.
        const out = await runJob(
          mintScheduledJob({
            duty: slug,
            executable: slugTarget,
            schedule: frontmatter.every,
            cliArgs: { [slugArg]: slug },
          }),
          { cwd: ctx.cwd, config: ctx.config, verbose: ctx.verbose, quiet: ctx.quiet, chain: false },
        )
        results.push({ slug, exitCode: out.exitCode, reason: out.reason })
        if (out.exitCode !== 0) {
          process.stderr.write(`[duties] tick ${slug} failed (exit ${out.exitCode}): ${out.reason ?? ""}\n`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[duties] tick ${slug} crashed: ${msg}\n`)
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
        process.stderr.write(`[duties] backend persist failed: ${msg}\n`)
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
 * Frontmatter is read once per slug by the caller (see `readJobFrontmatter`)
 * and the pre-parsed `every` is passed in. State load failures fall
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

/**
 * Cheap-and-tolerant frontmatter peek used per-tick by the dispatcher
 * loop. Single source of truth for both cadence (`every:`) and routing
 * (`tickScript:`). Returns an empty object on any read/parse failure so
 * callers can apply their own defaults (cadence falls through to "fire",
 * routing falls back to the LLM-driven target).
 */
function readJobFrontmatter(
  cwd: string,
  jobsDir: string,
  slug: string,
): ReturnType<typeof splitFrontmatter>["frontmatter"] {
  try {
    const raw = fs.readFileSync(path.join(cwd, jobsDir, `${slug}.md`), "utf-8")
    return splitFrontmatter(raw).frontmatter
  } catch {
    return {}
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

/** List folder-duty slugs (sub-directories containing a `profile.json`). */
function listFolderDutySlugs(absDir: string): string[] {
  if (!fs.existsSync(absDir)) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
    .filter((e) => fs.existsSync(path.join(absDir, e.name, "profile.json")))
    .map((e) => e.name)
    .sort()
}

/** Persist `lastFiredAt = now` for a scheduled folder-duty (no duty-tick to do it). */
async function stampFired(backend: ReturnType<typeof resolveBackend>, slug: string, now: number): Promise<void> {
  try {
    const loaded = await backend.load(slug)
    const nextData = { ...(loaded.state.data ?? {}), lastFiredAt: new Date(now).toISOString() }
    await backend.save(loaded, { ...loaded.state, data: nextData })
  } catch (err) {
    process.stderr.write(`[duties] failed to stamp lastFiredAt for ${slug}: ${String(err)}\n`)
  }
}
