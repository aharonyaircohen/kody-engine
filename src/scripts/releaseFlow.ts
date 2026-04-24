/**
 * Release executable flow. Pure wrapper logic — no agent invocation.
 *
 * Modes:
 *   `prepare`  (default): bump version files, generate CHANGELOG.md,
 *                         commit, open a release PR against defaultBranch.
 *                         Use this BEFORE merging.
 *   `finalize`          : run optional E2E gate, create tag, push,
 *                         run publishCommand, create GitHub release,
 *                         run notifyCommand. Use this AFTER merging
 *                         the release PR.
 */

import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"
import { gh, postIssueComment, truncate } from "../issue.js"

function notifyIssue(issueNumber: number | undefined, body: string, cwd: string): void {
  if (!issueNumber || issueNumber <= 0) return
  try {
    postIssueComment(issueNumber, body, cwd)
  } catch {
    /* best effort — issue-comment failure should not sink the release */
  }
}

export type BumpType = "patch" | "minor" | "major"
export type ReleaseMode = "prepare" | "finalize"
export type PreferSide = "ours" | "theirs"

export function bumpVersion(current: string, bump: BumpType): string {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/)
  if (!m) throw new Error(`cannot parse version '${current}' (expected x.y.z[-suffix])`)
  let [major, minor, patch] = [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)]
  if (bump === "major") {
    major++
    minor = 0
    patch = 0
  } else if (bump === "minor") {
    minor++
    patch = 0
  } else patch++
  return `${major}.${minor}.${patch}`
}

export function updateVersionInFile(file: string, newVersion: string, cwd: string): boolean {
  const abs = path.join(cwd, file)
  if (!fs.existsSync(abs)) return false
  const content = fs.readFileSync(abs, "utf-8")
  const updated = content.replace(/"version"\s*:\s*"[^"]+"/, `"version": "${newVersion}"`)
  if (updated === content) return false
  fs.writeFileSync(abs, updated)
  return true
}

/**
 * Build changelog entries from `git log <lastTag>..HEAD --pretty=...`
 * Filters out merge commits and existing release commits. Groups by
 * conventional-commit type. When there is no prior `v*` tag (fresh repo,
 * first release), cap the window to FIRST_RELEASE_COMMIT_CAP commits so
 * the generated entry stays under GitHub's 65536-char PR body limit.
 */
const FIRST_RELEASE_COMMIT_CAP = 100

export function generateChangelog(cwd: string, newVersion: string, lastTag: string | null): string {
  const logArgs = ["log", "--pretty=format:%s||%h", "--no-merges"]
  if (lastTag) logArgs.splice(1, 0, `${lastTag}..HEAD`)
  else logArgs.splice(1, 0, `-n${FIRST_RELEASE_COMMIT_CAP}`, "HEAD")
  let log = ""
  try {
    log = execFileSync("git", logArgs, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch {
    /* no commits or no tags */
  }

  const commits = log
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line) => {
      const [subject, sha] = line.split("||")
      return { subject: subject ?? "", sha: sha ?? "" }
    })
    .filter((c) => !/^chore:\s*release\s+v\d/i.test(c.subject))

  const groups: Record<string, string[]> = { feat: [], fix: [], perf: [], refactor: [], docs: [], chore: [], other: [] }
  for (const c of commits) {
    const m = c.subject.match(/^(\w+)(?:\(.*?\))?\s*:\s*(.+)$/)
    const type = m?.[1]?.toLowerCase() ?? "other"
    const msg = m?.[2] ?? c.subject
    const bucket = groups[type] ?? groups.other
    bucket.push(`- ${msg} (${c.sha})`)
  }

  const date = new Date().toISOString().slice(0, 10)
  const parts = [`## v${newVersion} — ${date}`, ""]
  const labels: Array<[string, string]> = [
    ["feat", "Features"],
    ["fix", "Fixes"],
    ["perf", "Performance"],
    ["refactor", "Refactoring"],
    ["docs", "Docs"],
    ["chore", "Chores"],
    ["other", "Other"],
  ]
  for (const [key, label] of labels) {
    const items = groups[key]
    if (!items || items.length === 0) continue
    parts.push(`### ${label}`)
    parts.push(...items)
    parts.push("")
  }
  if (parts.length === 2) parts.push("_No notable commits since the last release._", "")
  return parts.join("\n")
}

export function prependChangelog(cwd: string, entry: string): void {
  const p = path.join(cwd, "CHANGELOG.md")
  const header = "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n"
  if (fs.existsSync(p)) {
    const prior = fs.readFileSync(p, "utf-8")
    // Insert after the "# Changelog" header if present; else prepend.
    if (/^#\s*Changelog\b/m.test(prior)) {
      const idx = prior.indexOf("\n", prior.indexOf("# Changelog"))
      fs.writeFileSync(p, `${prior.slice(0, idx + 1)}\n${entry}${prior.slice(idx + 1)}`)
    } else {
      fs.writeFileSync(p, `${header}${entry}${prior}`)
    }
  } else {
    fs.writeFileSync(p, `${header}${entry}`)
  }
}

function git(args: string[], cwd: string, timeout = 60_000): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    timeout,
    cwd,
    env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

function lastReleaseTag(cwd: string): string | null {
  try {
    return git(["describe", "--tags", "--abbrev=0", "--match", "v*"], cwd)
  } catch {
    return null
  }
}

/**
 * True iff `origin/<branch>` exists. `git ls-remote` prints one line per
 * matching ref; empty output ⇒ no branch. Network failures raise — caller
 * treats an error as "unknown" and falls through to the normal push path,
 * where the push itself will report a clearer message.
 */
export function remoteBranchExists(branch: string, cwd: string): boolean {
  try {
    const out = git(["ls-remote", "--heads", "origin", branch], cwd, 30_000)
    return out.length > 0
  } catch {
    return false
  }
}

/**
 * Return the URL of the single open PR whose head is `branch`, or null if
 * none exists (or gh is unavailable). Used by `--prefer theirs` to link back
 * to the previously-opened release PR instead of re-creating work.
 */
export function findOpenPrForBranch(branch: string, cwd: string): string | null {
  try {
    const out = gh(["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--limit", "1"], { cwd })
    const parsed = JSON.parse(out || "[]") as Array<{ url?: string }>
    const first = parsed[0]
    return first?.url ?? null
  } catch {
    return null
  }
}

function runShell(cmd: string, cwd: string, timeoutMs: number): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1", CI: process.env.CI ?? "1" },
    encoding: "utf-8",
    timeout: timeoutMs,
  })
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

export const releaseFlow: PreflightScript = async (ctx) => {
  const mode = (ctx.args.mode as ReleaseMode | undefined) ?? "prepare"
  const bump = (ctx.args.bump as BumpType | undefined) ?? "patch"
  const dryRun = ctx.args["dry-run"] === true || ctx.args.dryRun === true
  const prefer = (ctx.args.prefer as PreferSide | undefined) ?? undefined
  const issueNumber = typeof ctx.args.issue === "number" ? ctx.args.issue : undefined
  const cwd = ctx.cwd
  const releaseCfg = ctx.config.release ?? {}
  const versionFiles =
    releaseCfg.versionFiles && releaseCfg.versionFiles.length > 0 ? releaseCfg.versionFiles : ["package.json"]
  const timeoutMs = releaseCfg.timeoutMs ?? 600_000

  ctx.skipAgent = true

  if (mode === "prepare") {
    await runPrepare({ cwd, bump, dryRun, prefer, versionFiles, ctx })
  } else if (mode === "finalize") {
    await runFinalize({ cwd, dryRun, timeoutMs, releaseCfg, ctx })
  } else {
    ctx.output.exitCode = 64
    ctx.output.reason = `release: unknown mode '${mode}'`
  }

  notifyIssue(issueNumber, buildIssueNotice(mode, dryRun, ctx), cwd)
}

/**
 * Compose the follow-up comment body from the flow's terminal state. One
 * call site ensures every exit path (success, dry-run, terminal failure,
 * unknown-mode) reports back to the triggering issue uniformly.
 */
function buildIssueNotice(
  mode: ReleaseMode | string,
  dryRun: boolean,
  ctx: Parameters<PreflightScript>[0],
): string {
  const exit = ctx.output.exitCode ?? 0
  const url = ctx.output.prUrl
  const reason = ctx.output.reason
  const label = mode === "finalize" ? "release finalize" : mode === "prepare" ? "release prepare" : `release ${mode}`

  if (exit !== 0) {
    const suffix = url ? ` — ${url}` : ""
    return `⚠️ kody ${label} failed: ${truncate(reason ?? "unknown error", 1500)}${suffix}`
  }
  if (dryRun) {
    return `ℹ️ kody ${label} (dry-run): ${reason ?? "plan printed, no changes applied"}`
  }
  if (mode === "prepare") {
    return url ? `✅ kody release PR opened: ${url}` : "✅ kody release prepared"
  }
  if (mode === "finalize") {
    return url ? `✅ kody release published: ${url}` : "✅ kody release finalized (tag pushed)"
  }
  return `✅ kody ${label} complete`
}

interface PrepareArgs {
  cwd: string
  bump: BumpType
  dryRun: boolean
  prefer: PreferSide | undefined
  versionFiles: string[]
  ctx: Parameters<PreflightScript>[0]
}

async function runPrepare(args: PrepareArgs): Promise<void> {
  const { cwd, bump, dryRun, prefer, versionFiles, ctx } = args

  const pkgPath = path.join(cwd, "package.json")
  if (!fs.existsSync(pkgPath)) {
    ctx.output.exitCode = 99
    ctx.output.reason = "release prepare: package.json not found"
    return
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string }
  if (typeof pkg.version !== "string") {
    ctx.output.exitCode = 99
    ctx.output.reason = "release prepare: package.json has no version"
    return
  }
  const oldVersion = pkg.version
  const newVersion = bumpVersion(oldVersion, bump)
  const tag = `v${newVersion}`

  process.stdout.write(`→ release prepare: ${oldVersion} → ${newVersion} (${bump})\n`)

  if (dryRun) {
    ctx.output.exitCode = 0
    ctx.output.reason = `dry-run — would bump to ${newVersion}${prefer ? ` (--prefer ${prefer})` : ""}`
    process.stdout.write(`RELEASE_PLAN=bump=${newVersion} tag=${tag}\n`)
    return
  }

  const releaseBranch = `release/${tag}`

  // Branch-collision gate. Check BEFORE doing work so `--prefer theirs` can
  // short-circuit to the existing PR without any local bump/commit.
  const collides = remoteBranchExists(releaseBranch, cwd)
  if (collides) {
    if (prefer === "theirs") {
      const existingPr = findOpenPrForBranch(releaseBranch, cwd)
      if (existingPr) {
        process.stdout.write(`  reusing existing PR (--prefer theirs): ${existingPr}\n`)
        ctx.output.prUrl = existingPr
        ctx.output.exitCode = 0
        return
      }
      ctx.output.exitCode = 4
      ctx.output.reason = `release prepare --prefer theirs: ${releaseBranch} exists on remote but has no open PR — nothing to reuse`
      return
    }
    if (prefer !== "ours") {
      ctx.output.exitCode = 4
      ctx.output.reason = `release prepare: branch ${releaseBranch} already exists on remote. Use --prefer ours to force-push, or --prefer theirs to reuse the existing PR.`
      return
    }
    process.stdout.write(`  branch ${releaseBranch} exists on remote — will force-push (--prefer ours)\n`)
  }

  // Bump version files.
  const touched: string[] = []
  for (const f of versionFiles) {
    if (updateVersionInFile(f, newVersion, cwd)) touched.push(f)
  }
  if (touched.length === 0) {
    ctx.output.exitCode = 1
    ctx.output.reason = `release prepare: no version strings updated (files: ${versionFiles.join(", ")})`
    return
  }
  process.stdout.write(`  wrote    ${touched.join(", ")}\n`)

  // Changelog.
  const entry = generateChangelog(cwd, newVersion, lastReleaseTag(cwd))
  prependChangelog(cwd, entry)
  process.stdout.write(`  wrote    CHANGELOG.md\n`)

  // Commit on a release branch. When the remote branch already exists and
  // --prefer ours was given, push with --force-with-lease — safer than
  // --force (fails if someone else landed a commit we don't know about).
  try {
    git(["checkout", "-b", releaseBranch], cwd)
    for (const f of [...touched, "CHANGELOG.md"]) git(["add", "--", f], cwd)
    git(["commit", "--no-gpg-sign", "-m", `chore: release ${tag}`], cwd)
    const pushArgs =
      collides && prefer === "ours"
        ? ["push", "-u", "--force-with-lease", "origin", releaseBranch]
        : ["push", "-u", "origin", releaseBranch]
    git(pushArgs, cwd, 120_000)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.output.exitCode = 4
    ctx.output.reason = `release prepare: git commit/push failed: ${msg}`
    return
  }

  // Open release PR — or, if `--prefer ours` force-pushed over an existing
  // branch that already has an open PR, link to that PR instead of failing
  // with "a pull request for branch already exists."
  const base = ctx.config.git.defaultBranch
  const title = `chore: release ${tag}`
  const bodyMax = 60000
  const rawEntry = entry.length > bodyMax ? `${entry.slice(0, bodyMax)}\n\n_… truncated; see CHANGELOG.md_` : entry
  const body = `Automated release PR opened by kody.\n\n${rawEntry}\n\nMerge this and then run \`kody release --mode finalize\`.`
  let prUrl = ""
  const preexistingPr = collides && prefer === "ours" ? findOpenPrForBranch(releaseBranch, cwd) : null
  if (preexistingPr) {
    process.stdout.write(`  PR already open for ${releaseBranch}: ${preexistingPr}\n`)
    prUrl = preexistingPr
  } else {
    try {
      prUrl = gh(["pr", "create", "--head", releaseBranch, "--base", base, "--title", title, "--body-file", "-"], {
        input: body,
        cwd,
      }).trim()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.output.exitCode = 4
      ctx.output.reason = `release prepare: gh pr create failed: ${msg}`
      return
    }
  }

  ctx.output.prUrl = prUrl
  ctx.output.exitCode = 0
  process.stdout.write(`RELEASE_PR=${prUrl}\n`)
}

interface FinalizeArgs {
  cwd: string
  dryRun: boolean
  timeoutMs: number
  releaseCfg: NonNullable<KodyConfig["release"]>
  ctx: Parameters<PreflightScript>[0]
}

// Re-import for the closure type above.
import type { KodyConfig } from "../config.js"

async function runFinalize(args: FinalizeArgs): Promise<void> {
  const { cwd, dryRun, timeoutMs, releaseCfg, ctx } = args

  const pkgPath = path.join(cwd, "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string }
  if (typeof pkg.version !== "string") {
    ctx.output.exitCode = 99
    ctx.output.reason = "release finalize: package.json has no version"
    return
  }
  const version = pkg.version
  const tag = `v${version}`

  process.stdout.write(`→ release finalize: ${tag}\n`)

  // Refuse if the tag already exists.
  try {
    git(["rev-parse", "--verify", tag], cwd)
    ctx.output.exitCode = 1
    ctx.output.reason = `release finalize: tag ${tag} already exists`
    return
  } catch {
    /* good — tag doesn't exist */
  }

  if (dryRun) {
    ctx.output.exitCode = 0
    ctx.output.reason = `dry-run — would tag + publish ${tag}`
    return
  }

  // Optional E2E gate.
  if (releaseCfg.e2eCommand && releaseCfg.e2eCommand.trim().length > 0) {
    const cmd = releaseCfg.e2eCommand.replace(/\$VERSION/g, version)
    process.stdout.write(`  E2E gate: ${cmd}\n`)
    const r = runShell(cmd, cwd, timeoutMs)
    if (r.exitCode !== 0) {
      ctx.output.exitCode = 2
      ctx.output.reason = `release finalize: E2E gate failed (exit ${r.exitCode}): ${truncate(r.stderr, 600)}`
      return
    }
  }

  // Tag + push.
  try {
    git(["tag", "-a", tag, "-m", `Release ${tag}`], cwd)
    git(["push", "origin", tag], cwd, 120_000)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.output.exitCode = 4
    ctx.output.reason = `release finalize: tag/push failed: ${msg}`
    return
  }

  // Publish.
  let publishStatus: "skipped" | "ok" | "failed" = "skipped"
  if (releaseCfg.publishCommand && releaseCfg.publishCommand.trim().length > 0) {
    const cmd = releaseCfg.publishCommand.replace(/\$VERSION/g, version)
    process.stdout.write(`  publish: ${cmd}\n`)
    const r = runShell(cmd, cwd, timeoutMs)
    publishStatus = r.exitCode === 0 ? "ok" : "failed"
    if (r.exitCode !== 0) {
      process.stderr.write(`[kody release] publishCommand exit ${r.exitCode}\n${truncate(r.stderr, 2000)}\n`)
    }
  }

  // GitHub release.
  let releaseUrl = ""
  try {
    const releaseArgs = ["release", "create", tag, "--title", tag, "--notes", `Release ${tag} — automated by kody.`]
    if (releaseCfg.draftRelease) releaseArgs.push("--draft")
    releaseUrl = gh(releaseArgs, { cwd }).trim()
  } catch (err) {
    process.stderr.write(
      `[kody release] gh release create failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }

  // Optional notify.
  if (releaseCfg.notifyCommand && releaseCfg.notifyCommand.trim().length > 0) {
    const cmd = releaseCfg.notifyCommand.replace(/\$VERSION/g, version)
    runShell(cmd, cwd, timeoutMs)
  }

  if (releaseUrl) ctx.output.prUrl = releaseUrl
  if (publishStatus === "failed") {
    ctx.output.exitCode = 1
    ctx.output.reason = `release finalize: tag + gh release created, but publishCommand failed`
    return
  }
  ctx.output.exitCode = 0
  process.stdout.write(`RELEASE_TAG=${tag}\n`)
  if (releaseUrl) process.stdout.write(`RELEASE_URL=${releaseUrl}\n`)
}
