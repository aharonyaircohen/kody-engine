/**
 * initFlow — preflight for the `init` executable.
 *
 * Scaffolds a consumer repo: writes `kody.config.json` and
 * `.github/workflows/kody.yml` if absent (or when `--force`). Detects the
 * package manager from lockfiles to pre-fill `quality.*` commands. Reads
 * repo owner/name from `git remote get-url origin` when available; leaves
 * placeholders otherwise. Sets `ctx.skipAgent = true` — init never calls
 * the agent.
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import pkg from "../../package.json"
import type { PreflightScript } from "../executables/types.js"
import { type EnsureLabelsResult, ensureLabels } from "../lifecycleLabels.js"
import { loadProfile } from "../profile.js"
import { listBuiltinJobs, listExecutables } from "../registry.js"

type PackageManager = "pnpm" | "yarn" | "bun" | "npm"

function detectPackageManager(cwd: string): PackageManager {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm"
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn"
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun"
  return "npm"
}

function qualityCommandsFor(pm: PackageManager): { typecheck: string; lint: string; testUnit: string } {
  return {
    typecheck: `${pm} tsc --noEmit`,
    lint: "",
    testUnit: `${pm} test`,
  }
}

interface OwnerRepo {
  owner: string
  repo: string
}

// Derive the published config schema URL from this package's own
// repository.url, so a fork that republishes under its own scope points
// `kody init` consumers at the fork's schema instead of the original repo.
function schemaUrlFromPkg(): string {
  const fallback = "https://raw.githubusercontent.com/aharonyaircohen/kody-engine/main/kody.config.schema.json"
  const repoUrl = (pkg as { repository?: { url?: string } }).repository?.url
  const m = repoUrl?.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/) ?? null
  if (!m) return fallback
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/main/kody.config.schema.json`
}

function detectOwnerRepo(cwd: string): OwnerRepo | null {
  let url: string
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch {
    return null
  }
  // Match both SSH (git@github.com:owner/repo.git) and HTTPS
  // (https://github.com/owner/repo.git or .../repo).
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/) ?? null
  if (!m) return null
  return { owner: m[1]!, repo: m[2]! }
}

function makeConfig(pm: PackageManager, ownerRepo: OwnerRepo | null, defaultBranch: string): Record<string, unknown> {
  return {
    $schema: schemaUrlFromPkg(),
    quality: qualityCommandsFor(pm),
    git: { defaultBranch },
    github: {
      owner: ownerRepo?.owner ?? "OWNER",
      repo: ownerRepo?.repo ?? "REPO",
    },
    agent: {
      model: "minimax/MiniMax-M2.7-highspeed",
    },
  }
}

const WORKFLOW_TEMPLATE = `# Drop this file at .github/workflows/kody.yml in your repo.
#
# Triggers: @kody comment on an issue or PR, or manual workflow_dispatch.
# Everything else (install deps, set up LiteLLM, run the agent, open the PR)
# is handled inside the @kody-ade/kody-engine package.
#
# Required repo secrets: at least one model provider key (e.g. MINIMAX_API_KEY,
# ANTHROPIC_API_KEY). kody reads any *_API_KEY secret automatically via
# toJSON(secrets) — no need to list them here.
#
# Recommended: KODY_TOKEN secret — a PAT or GitHub App token with repo
# scope so kody's pushes trigger downstream CI and PR-body edits succeed.

name: kody

on:
  workflow_dispatch:
    inputs:
      issue_number:
        description: "GitHub issue number"
        required: true
        type: string
  issue_comment:
    types: [created]

jobs:
  run:
    if: >-
      \${{ github.event_name == 'workflow_dispatch' ||
          (github.event_name == 'issue_comment' &&
            contains(github.event.comment.body, '@kody')) }}
    runs-on: ubuntu-latest
    timeout-minutes: 60
    permissions:
      issues: write
      pull-requests: write
      contents: write
      actions: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.KODY_TOKEN || github.token }}

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - env:
          ALL_SECRETS: \${{ toJSON(secrets) }}
        run: npx -y -p @kody-ade/kody-engine@latest kody-engine ci
`

const DEFAULT_STAFF_PERSONA = `# Kody

You are Kody, the default maintenance staff member for scheduled duties.

Keep actions narrow, prefer read-only inspection, and only use the tools or commands named by the duty.
When a duty writes a report or dispatches work, keep the output factual and concise.
`

function defaultBranchFromGit(cwd: string): string {
  try {
    const ref = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    return ref.replace("refs/remotes/origin/", "")
  } catch {
    try {
      return (
        execFileSync("git", ["branch", "--show-current"], {
          cwd,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim() || "main"
      )
    } catch {
      return "main"
    }
  }
}

export interface InitResult {
  wrote: string[]
  skipped: string[]
  /**
   * Slugs where a folder duty and a `.md` duty collide on disk. The folder
   * wins at runtime (dedup'd in `dispatchDutyFileTicks`); `kody init` surfaces
   * the collision as a one-time deprecation nudge so the user can migrate or
   * remove the orphan markdown. See issue #50.
   */
  collisions?: string[]
  labels?: EnsureLabelsResult
}

export function performInit(cwd: string, force: boolean): InitResult {
  const wrote: string[] = []
  const skipped: string[] = []
  const collisions: string[] = []

  const pm = detectPackageManager(cwd)
  const ownerRepo = detectOwnerRepo(cwd)
  const defaultBranch = defaultBranchFromGit(cwd)

  // 1. kody.config.json
  const configPath = path.join(cwd, "kody.config.json")
  if (fs.existsSync(configPath) && !force) {
    skipped.push("kody.config.json")
  } else {
    const cfg = makeConfig(pm, ownerRepo, defaultBranch)
    fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`)
    wrote.push("kody.config.json")
  }

  // 2. .github/workflows/kody.yml
  const workflowDir = path.join(cwd, ".github", "workflows")
  const workflowPath = path.join(workflowDir, "kody.yml")
  if (fs.existsSync(workflowPath) && !force) {
    skipped.push(".github/workflows/kody.yml")
  } else {
    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(workflowPath, WORKFLOW_TEMPLATE)
    wrote.push(".github/workflows/kody.yml")
  }

  // 3. .kody/duties/<slug>/{profile.json,prompt.md} — copy every built-in
  //    duty folder shipped with the engine. Built-in duties live under
  //    `src/jobs/<slug>/` (dev) / `dist/jobs/<slug>/` (built); consumer
  //    repos get a starter copy of each, scaffolded once and then
  //    human-edited. Cadence is enforced by the profile's `every` field,
  //    read by `dispatchDutyFileTicks`.
  //
  //    Folder shape is the unified successor to the legacy `<slug>.md`
  //    file: dispatching the same slug from both a folder and a `.md` is
  //    a dedup'd fire (folder wins, `.md` skipped). Markdown-only
  //    built-ins are still discovered and copied as a single `.md` so
  //    a half-migrated engine doesn't drop duties — the deprecation
  //    log + removal land in #46-B.
  //
  //    `--force` will overwrite consumer edits to these files — same
  //    contract as `kody.yml` and `kody.config.json` above. Duty
  //    profiles + bodies are *intended* to be edited (cadence,
  //    thresholds, prompt prose), so use `--force` only when you accept
  //    losing those edits.
  const builtinJobs = listBuiltinJobs()
  if (builtinJobs.length > 0) {
    const jobsDir = path.join(cwd, ".kody", "duties")
    fs.mkdirSync(jobsDir, { recursive: true })
    for (const job of builtinJobs) {
      if (job.filePath && !job.profilePath) {
        // Legacy `.md` built-in: copy as-is. Removed once #46-B lands.
        const rel = path.join(".kody", "duties", `${job.slug}.md`)
        const target = path.join(cwd, rel)
        if (fs.existsSync(target) && !force) {
          skipped.push(rel)
          continue
        }
        fs.writeFileSync(target, fs.readFileSync(job.filePath, "utf-8"))
        wrote.push(rel)
        continue
      }
      const targetDir = path.join(jobsDir, job.slug)
      const relProfile = path.join(".kody", "duties", job.slug, "profile.json")
      const relPrompt = path.join(".kody", "duties", job.slug, "prompt.md")
      if (fs.existsSync(targetDir) && fs.existsSync(path.join(targetDir, "profile.json")) && !force) {
        skipped.push(relProfile)
        skipped.push(relPrompt)
        continue
      }
      fs.mkdirSync(targetDir, { recursive: true })
      fs.writeFileSync(path.join(targetDir, "profile.json"), fs.readFileSync(job.profilePath, "utf-8"))
      fs.writeFileSync(path.join(targetDir, "prompt.md"), fs.readFileSync(job.promptPath, "utf-8"))
      wrote.push(relProfile)
      wrote.push(relPrompt)
    }

    // Collision nudge: a folder duty and a `.md` duty with the same slug
    // are dedup'd at runtime (folder wins, .md is skipped — see
    // `dispatchDutyFileTicks`), but the markdown sibling is a legacy shape
    // the user almost certainly wants to migrate or remove. Surface the
    // collision here so `kody init` is the one place that tells the user
    // "you have a stale markdown next to a folder duty" — the runtime
    // nudge fires only on the cron wake, which may be infrequent.
    for (const slug of findShadowCollisions(jobsDir)) {
      collisions.push(slug)
      // One nudge per colliding slug per init run. Points at the consumer
      // migration subsection in duty-dispatch.md (the closest thing to a
      // "legacy markdown" subsection in the docs as of #50).
      process.stdout.write(
        `[duties] markdown duty '${slug}' is shadowed by folder duty; migrate or remove (see docs/duty-dispatch.md#consumer-migration)\n`,
      )
    }
  }

  // 4. .kody/staff/kody.md — default persona referenced by bundled duties.
  const staffDir = path.join(cwd, ".kody", "staff")
  const staffPath = path.join(staffDir, "kody.md")
  if (fs.existsSync(staffPath) && !force) {
    skipped.push(".kody/staff/kody.md")
  } else {
    fs.mkdirSync(staffDir, { recursive: true })
    fs.writeFileSync(staffPath, DEFAULT_STAFF_PERSONA)
    wrote.push(".kody/staff/kody.md")
  }

  // 5. .github/workflows/kody-<name>.yml for every discovered scheduled executable.
  for (const exe of listExecutables()) {
    let profile: ReturnType<typeof loadProfile>
    try {
      profile = loadProfile(exe.profilePath)
    } catch {
      continue
    }
    if (profile.kind !== "scheduled" || !profile.schedule) continue
    const target = path.join(workflowDir, `kody-${exe.name}.yml`)
    if (fs.existsSync(target) && !force) {
      skipped.push(`.github/workflows/kody-${exe.name}.yml`)
      continue
    }
    fs.writeFileSync(target, renderScheduledWorkflow(exe.name, profile.schedule))
    wrote.push(`.github/workflows/kody-${exe.name}.yml`)
  }

  // 6. Create/update every kody-owned label declared across the executable
  //    profile set. Best-effort: if `gh` isn't installed/authenticated, this
  //    is skipped silently and setKodyLabel will lazily create the label on
  //    first use during a real flow run.
  let labels: EnsureLabelsResult | undefined
  try {
    labels = ensureLabels(cwd)
  } catch {
    labels = undefined
  }

  const result: InitResult = { wrote, skipped, labels }
  if (collisions.length > 0) result.collisions = collisions
  return result
}

/**
 * Find every slug in `jobsDir` that exists as BOTH a `.md` file and a
 * folder shape — a runtime-shadow collision that `dispatchDutyFileTicks`
 * dedups at tick time. Sorted by slug for stable output. Returns an
 * empty array if the directory doesn't exist (e.g. on a brand-new repo
 * before any duties are scaffolded).
 */
function findShadowCollisions(jobsDir: string): string[] {
  if (!fs.existsSync(jobsDir)) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(jobsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const mdSlugs = new Set<string>()
  const folderSlugs = new Set<string>()
  for (const e of entries) {
    if (e.name.startsWith("_") || e.name.startsWith(".")) continue
    if (e.isFile() && e.name.endsWith(".md")) mdSlugs.add(e.name.slice(0, -3))
    else if (e.isDirectory()) folderSlugs.add(e.name)
  }
  return [...mdSlugs].filter((s) => folderSlugs.has(s)).sort()
}

export function renderScheduledWorkflow(name: string, cron: string): string {
  return `# Scheduled kody executable: ${name}
# Generated by \`kody init\`. Regenerate with \`kody init --force\`.
# Edit the cron below or the executable's profile.json#schedule.

name: kody ${name}

on:
  schedule:
    - cron: "${cron}"
  workflow_dispatch:

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      issues: write
      pull-requests: read
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          token: \${{ secrets.KODY_TOKEN || github.token }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - env:
          GH_TOKEN: \${{ secrets.KODY_TOKEN || github.token }}
        run: npx -y -p @kody-ade/kody-engine@latest kody-engine ${name}
`
}

export const initFlow: PreflightScript = async (ctx) => {
  const force = ctx.args.force === true
  const cwd = ctx.cwd

  const { wrote, skipped, labels } = performInit(cwd, force)

  process.stdout.write("→ kody init\n")
  for (const f of wrote) process.stdout.write(`  wrote    ${f}\n`)
  for (const f of skipped) process.stdout.write(`  skipped  ${f} (already exists; pass --force to overwrite)\n`)
  if (labels) {
    if (labels.created.length > 0) {
      process.stdout.write(`  labels   ensured ${labels.created.length} lifecycle label(s)\n`)
    }
    if (labels.failed.length > 0) {
      process.stdout.write(`  labels   ${labels.failed.length} failed (gh auth missing? will self-heal on first run)\n`)
    }
  }
  process.stdout.write(
    wrote.length > 0
      ? `\nDone. Edit kody.config.json to pick your model, then push the workflow file.\n`
      : `\nNothing to do. All files already present. (Use --force to overwrite.)\n`,
  )

  // Init never invokes the agent.
  ctx.skipAgent = true
  ctx.output.exitCode = 0
}
