/**
 * initFlow — preflight for the `init` executable.
 *
 * Scaffolds a consumer repo: writes `kody.config.json` and
 * `.github/workflows/kody2.yml` if absent (or when `--force`). Detects the
 * package manager from lockfiles to pre-fill `quality.*` commands. Reads
 * repo owner/name from `git remote get-url origin` when available; leaves
 * placeholders otherwise. Sets `ctx.skipAgent = true` — init never calls
 * the agent.
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"
import { loadProfile } from "../profile.js"
import { listExecutables } from "../registry.js"

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
    $schema: "https://raw.githubusercontent.com/aharonyaircohen/kody-engine/main/kody.config.schema.json",
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

const WORKFLOW_TEMPLATE = `# Drop this file at .github/workflows/kody2.yml in your repo.
#
# Triggers: @kody2 comment on an issue or PR, or manual workflow_dispatch.
# Everything else (install deps, set up LiteLLM, run the agent, open the PR)
# is handled inside the @kody-ade/kody-engine package.
#
# Required repo secrets: at least one model provider key (e.g. MINIMAX_API_KEY,
# ANTHROPIC_API_KEY). kody2 reads any *_API_KEY secret automatically via
# toJSON(secrets) — no need to list them here.
#
# Recommended: KODY_TOKEN secret — a PAT or GitHub App token with repo
# scope so kody2's pushes trigger downstream CI and PR-body edits succeed.

name: kody2

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
            !github.event.issue.pull_request &&
            contains(github.event.comment.body, '@kody2')) }}
    runs-on: ubuntu-latest
    timeout-minutes: 60
    permissions:
      issues: write
      pull-requests: write
      contents: write
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
        run: npx -y -p @kody-ade/kody-engine@latest kody2 ci --issue \${{ github.event.inputs.issue_number || github.event.issue.number }}
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
}

export function performInit(cwd: string, force: boolean): InitResult {
  const wrote: string[] = []
  const skipped: string[] = []

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

  // 2. .github/workflows/kody2.yml
  const workflowDir = path.join(cwd, ".github", "workflows")
  const workflowPath = path.join(workflowDir, "kody2.yml")
  if (fs.existsSync(workflowPath) && !force) {
    skipped.push(".github/workflows/kody2.yml")
  } else {
    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(workflowPath, WORKFLOW_TEMPLATE)
    wrote.push(".github/workflows/kody2.yml")
  }

  // 3. .github/workflows/kody2-<name>.yml for every discovered scheduled executable.
  for (const exe of listExecutables()) {
    let profile: ReturnType<typeof loadProfile>
    try {
      profile = loadProfile(exe.profilePath)
    } catch {
      continue
    }
    if (profile.kind !== "scheduled" || !profile.schedule) continue
    const target = path.join(workflowDir, `kody2-${exe.name}.yml`)
    if (fs.existsSync(target) && !force) {
      skipped.push(`.github/workflows/kody2-${exe.name}.yml`)
      continue
    }
    fs.writeFileSync(target, renderScheduledWorkflow(exe.name, profile.schedule))
    wrote.push(`.github/workflows/kody2-${exe.name}.yml`)
  }

  return { wrote, skipped }
}

export function renderScheduledWorkflow(name: string, cron: string): string {
  return `# Scheduled kody2 executable: ${name}
# Generated by \`kody2 init\`. Regenerate with \`kody2 init --force\`.
# Edit the cron below or the executable's profile.json#schedule.

name: kody2 ${name}

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
      - env:
          GH_TOKEN: \${{ secrets.KODY_TOKEN || github.token }}
        run: npx -y -p @kody-ade/kody-engine@latest kody2 ${name}
`
}

export const initFlow: PreflightScript = async (ctx) => {
  const force = ctx.args.force === true
  const cwd = ctx.cwd

  const { wrote, skipped } = performInit(cwd, force)

  process.stdout.write("→ kody2 init\n")
  for (const f of wrote) process.stdout.write(`  wrote    ${f}\n`)
  for (const f of skipped) process.stdout.write(`  skipped  ${f} (already exists; pass --force to overwrite)\n`)
  process.stdout.write(
    wrote.length > 0
      ? `\nDone. Edit kody.config.json to pick your model, then push the workflow file.\n`
      : `\nNothing to do. All files already present. (Use --force to overwrite.)\n`,
  )

  // Init never invokes the agent.
  ctx.skipAgent = true
  ctx.output.exitCode = 0
}
