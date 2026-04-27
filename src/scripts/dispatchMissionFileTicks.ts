/**
 * Preflight: enumerate `.kody/missions/<slug>.md` files in the cwd, then
 * invoke a target executable once per mission slug (in-process, sequentially).
 *
 * Replaces the issue-label discovery in `dispatchMissionTicks` with file
 * discovery — missions live as authored markdown in the repo, not as issues.
 *
 * Script args (via `with:`):
 *   missionsDir        optional — relative path under cwd (default ".kody/missions")
 *   targetExecutable   required — e.g. "mission-tick"
 *   slugArg            optional — CLI input name on the target (default "mission")
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"
import { runExecutable } from "../executor.js"

export const dispatchMissionFileTicks: PreflightScript = async (ctx, _profile, args) => {
  ctx.skipAgent = true

  const targetExecutable = String(args?.targetExecutable ?? "")
  if (!targetExecutable) {
    throw new Error("dispatchMissionFileTicks: `with.targetExecutable` is required")
  }
  const missionsDir = String(args?.missionsDir ?? ".kody/missions")
  const slugArg = String(args?.slugArg ?? "mission")

  const slugs = listMissionSlugs(path.join(ctx.cwd, missionsDir))
  ctx.data.missionSlugCount = slugs.length

  if (slugs.length === 0) {
    process.stdout.write(`[missions] no mission files in ${missionsDir}\n`)
    return
  }

  process.stdout.write(`[missions] ticking ${slugs.length} mission(s) via ${targetExecutable}\n`)

  const results: Array<{ slug: string; exitCode: number; reason?: string }> = []
  for (const slug of slugs) {
    process.stdout.write(`[missions] → tick ${slug}\n`)
    try {
      const out = await runExecutable(targetExecutable, {
        cliArgs: { [slugArg]: slug },
        cwd: ctx.cwd,
        config: ctx.config,
        verbose: ctx.verbose,
        quiet: ctx.quiet,
      })
      results.push({ slug, exitCode: out.exitCode, reason: out.reason })
      if (out.exitCode !== 0) {
        process.stderr.write(`[missions] tick ${slug} failed (exit ${out.exitCode}): ${out.reason ?? ""}\n`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[missions] tick ${slug} crashed: ${msg}\n`)
      results.push({ slug, exitCode: 99, reason: msg })
    }
  }

  ctx.data.missionTickResults = results
  // Scheduler always exits 0 — individual tick failures are reported per-slug
  // in stderr but don't fail the cron job.
  ctx.output.exitCode = 0
}

function listMissionSlugs(absDir: string): string[] {
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
