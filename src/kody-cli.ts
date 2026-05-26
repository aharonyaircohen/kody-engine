import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { loadConfig, needsLitellmProxy, parseProviderModel } from "./config.js"
import { autoDispatch, autoDispatchTyped, type DispatchResult, dispatchScheduledWatches } from "./dispatch.js"
import { postIssueComment as ghPostIssueComment, postPrReviewComment as ghPostPrReviewComment } from "./issue.js"
import { runExecutable } from "./executor.js"
import { reactToTriggerComment } from "./gha.js"
import { postIssueComment, truncate } from "./issue.js"

type PackageManager = "pnpm" | "yarn" | "bun" | "npm"

export interface CiArgs {
  /** Explicit issue number (legacy flag). If omitted, autoDispatch reads the GHA event. */
  issueNumber?: number
  cwd?: string
  verbose?: boolean
  quiet?: boolean
  skipInstall?: boolean
  skipLitellm?: boolean
  packageManager?: PackageManager
  errors: string[]
}

export const CI_HELP = `kody ci — minimal-YAML autonomous engineer (CI preflight + run)

Usage:
  kody ci --issue <N> [--cwd <path>] [--verbose|--quiet]
           [--skip-install] [--skip-litellm] [--package-manager pnpm|yarn|bun|npm]

Options:
  --issue <N>          GitHub issue number to work on (required)
  --cwd <path>         Project directory (default: cwd)
  --verbose            Print full tool output
  --quiet              Print only errors and final PR_URL
  --skip-install       Skip dependency install (pre-warmed runners)
  --skip-litellm       Skip LiteLLM proxy install (Anthropic-direct)
  --package-manager    Override package-manager auto-detect

Environment:
  ALL_SECRETS          JSON blob of all GitHub secrets (auto-populated in CI)
  KODY_TOKEN|GH_TOKEN|GITHUB_TOKEN|GH_PAT   auth token for gh/git operations

Exit codes (inherited from kody run):
  0   success (PR opened, verify passed)
  1   agent reported FAILED (draft PR opened)
  2   verify failed (no PR opened — branch pushed for inspection)
  3   no commits to ship
  4   PR creation failed
  99  wrapper crashed
`

export function parseCiArgs(argv: string[]): CiArgs {
  const result: CiArgs = { errors: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--issue") {
      const n = parseInt(argv[++i] ?? "", 10)
      if (Number.isNaN(n) || n <= 0) result.errors.push("--issue requires a positive integer")
      else result.issueNumber = n
    } else if (arg === "--cwd") {
      result.cwd = argv[++i]
    } else if (arg === "--verbose") result.verbose = true
    else if (arg === "--quiet") result.quiet = true
    else if (arg === "--skip-install") result.skipInstall = true
    else if (arg === "--skip-litellm") result.skipLitellm = true
    else if (arg === "--package-manager") {
      const v = argv[++i]
      if (v === "pnpm" || v === "yarn" || v === "bun" || v === "npm") result.packageManager = v
      else result.errors.push(`--package-manager must be one of pnpm|yarn|bun|npm (got: ${v})`)
    } else if (arg === "--help" || arg === "-h") {
      result.errors.push("__HELP__")
    } else if (arg?.startsWith("--")) {
      result.errors.push(`unknown arg: ${arg}`)
    } else if (arg) {
      result.errors.push(`unexpected positional: ${arg}`)
    }
  }
  if (!result.issueNumber && !result.errors.includes("__HELP__")) {
    result.errors.push("--issue <N> is required")
  }
  return result
}

export function unpackAllSecrets(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALL_SECRETS
  if (!raw) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 0
  }
  if (!parsed || typeof parsed !== "object") return 0
  let count = 0
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string" || !v) continue
    if (env[k] !== undefined) continue
    env[k] = v
    count++
  }
  return count
}

export function resolveAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const sources: Array<[string, string | undefined]> = [
    ["KODY_TOKEN", env.KODY_TOKEN],
    ["GH_TOKEN", env.GH_TOKEN],
    ["GITHUB_TOKEN", env.GITHUB_TOKEN],
    ["GH_PAT", env.GH_PAT],
  ]
  const picked = sources.find(([, v]) => !!v)
  const token = picked?.[1]
  if (token && !env.GH_TOKEN) env.GH_TOKEN = token
  if (token) {
    // Log only which env var the token came from — no length/prefix/hash
    // (that was temporary diagnostics for the kodyade throttle hunt).
    process.stdout.write(`→ kody: GH_TOKEN sourced from env.${picked![0]}\n`)
  } else {
    process.stdout.write("→ kody: WARNING no auth token found (KODY_TOKEN/GH_TOKEN/GITHUB_TOKEN/GH_PAT all empty)\n")
  }
  return token
}

export function detectPackageManager(cwd: string): PackageManager {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm"
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn"
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun"
  return "npm"
}

function shellOut(cmd: string, args: string[], cwd: string, stream = true): number {
  try {
    execFileSync(cmd, args, {
      cwd,
      stdio: stream ? "inherit" : "pipe",
      env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1", CI: process.env.CI ?? "1" },
    })
    return 0
  } catch (err: unknown) {
    const e = err as { status?: number }
    return e.status ?? 1
  }
}

function isOnPath(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

// Pin a known-good major when bootstrapping a missing package manager.
// `npm install -g pnpm` (unpinned) fetches whatever's "latest" on npm,
// which on 2026-05-07 is pnpm 11 — incompatible with the engines.pnpm
// constraint (^9 || ^10) shipped by most consumer repos. Pin to the
// last known-good major; consumers that need newer can install pnpm
// themselves and skip this branch.
const PM_BOOTSTRAP_VERSION: Record<PackageManager, string> = {
  pnpm: "10",
  yarn: "1",
  bun: "1",
  npm: "latest",
}

export function ensurePackageManagerInstalled(pm: PackageManager, cwd: string): number {
  if (pm === "npm" || isOnPath(pm)) return 0
  const spec = `${pm}@${PM_BOOTSTRAP_VERSION[pm]}`
  process.stdout.write(`→ kody: ${pm} not on PATH — installing via npm install -g ${spec}\n`)
  return shellOut("npm", ["install", "-g", spec], cwd)
}

export function installDeps(pm: PackageManager, cwd: string): number {
  const ensureCode = ensurePackageManagerInstalled(pm, cwd)
  if (ensureCode !== 0) return ensureCode
  const args: Record<PackageManager, string[]> = {
    pnpm: ["install", "--frozen-lockfile"],
    yarn: ["install", "--frozen-lockfile"],
    bun: ["install", "--frozen-lockfile"],
    npm: ["ci"],
  }
  return shellOut(pm, args[pm], cwd)
}

export function installLitellmIfNeeded(cwd: string): number {
  try {
    const cfg = loadConfig(cwd)
    const model = parseProviderModel(cfg.agent.model)
    if (!needsLitellmProxy(model)) {
      process.stdout.write("→ kody: provider is anthropic/claude, skipping LiteLLM install\n")
      return 0
    }
  } catch {
    // Config missing or invalid — install LiteLLM defensively; run() will fail later with a clearer error.
  }
  // Check if litellm already importable
  try {
    execFileSync("python3", ["-c", "import litellm"], { stdio: "pipe" })
    process.stdout.write("→ kody: litellm already installed\n")
    return 0
  } catch {
    // not installed
  }
  process.stdout.write("→ kody: installing litellm (pip install 'litellm[proxy]')\n")
  return shellOut("pip", ["install", "litellm[proxy]"], cwd)
}

export function configureGitIdentity(cwd: string): void {
  try {
    const name = execFileSync("git", ["config", "user.name"], { cwd, stdio: "pipe", encoding: "utf-8" }).trim()
    if (name) return
  } catch {
    /* not set */
  }
  try {
    execFileSync("git", ["config", "user.name", "github-actions[bot]"], { cwd, stdio: "pipe" })
  } catch {
    /* best effort */
  }
  try {
    execFileSync("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], {
      cwd,
      stdio: "pipe",
    })
  } catch {
    /* best effort */
  }
}

function postFailureTail(issueNumber: number | undefined, cwd: string, reason: string): void {
  if (!issueNumber) return
  const logPath = path.join(cwd, ".kody", "last-run.jsonl")
  let tail = ""
  try {
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, "utf-8")
      tail = content.slice(-3000)
    }
  } catch {
    /* best effort */
  }
  const body = tail
    ? `⚠️ kody preflight failed: ${truncate(reason, 500)}\n\n<details><summary>Last-run log tail</summary>\n\n\`\`\`\n${tail}\n\`\`\`\n\n</details>`
    : `⚠️ kody preflight failed: ${truncate(reason, 1500)}`
  try {
    postIssueComment(issueNumber, body, cwd)
  } catch {
    /* best effort */
  }
}

export async function runCi(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(CI_HELP)
    return 0
  }

  const args = parseCiArgs(argv)
  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd()
  // Load config early so autoDispatch can consult defaultExecutable.
  let earlyConfig: ReturnType<typeof loadConfig> | undefined
  try {
    earlyConfig = loadConfig(cwd)
  } catch {
    /* will surface later with a clearer message if needed */
  }

  // --issue is only required when autoDispatch can't infer from GHA env.
  const autoFallback = !args.issueNumber ? autoDispatch({ config: earlyConfig }) : null

  // Schedule wakes and parameterless workflow_dispatch fan out to every
  // watch executable whose `schedule` cron matches the wake window
  // (workflow_dispatch ignores the cron — it's an explicit "fire all").
  // job-scheduler is itself a watch and continues to fire from this
  // path; nightly suites and any future watch executables join naturally,
  // no kody.yml or config edits.
  const eventName = process.env.GITHUB_EVENT_NAME
  const dispatchEventPath = process.env.GITHUB_EVENT_PATH
  let manualWorkflowDispatch = false
  if (
    !args.issueNumber &&
    !autoFallback &&
    eventName === "workflow_dispatch" &&
    dispatchEventPath &&
    fs.existsSync(dispatchEventPath)
  ) {
    try {
      const evt = JSON.parse(fs.readFileSync(dispatchEventPath, "utf-8"))
      const issueInput = parseInt(String(evt?.inputs?.issue_number ?? ""), 10)
      const sessionInput = String(evt?.inputs?.sessionId ?? "")
      manualWorkflowDispatch = !sessionInput && !(Number.isFinite(issueInput) && issueInput > 0)
    } catch {
      manualWorkflowDispatch = false
    }
  }
  if (!args.issueNumber && !autoFallback && (eventName === "schedule" || manualWorkflowDispatch)) {
    return runScheduledFanOut(cwd, args, { force: manualWorkflowDispatch })
  }

  // Event present but dispatch returned null (e.g. merged non-release PR,
  // non-@kody comment) — exit 0 before paying for dep install. BUT: if the
  // null was because we couldn't recognize an `@kody <token>` the user
  // typed, post a feedback comment so the user isn't left wondering. This
  // turns the previously-silent "I typed @kody xyz and nothing happened"
  // into an observable, actionable signal.
  if (!args.issueNumber && !autoFallback && process.env.GITHUB_EVENT_NAME) {
    const outcome = autoDispatchTyped({ config: earlyConfig })
    if (outcome.kind === "unrecognized") {
      // Unpack secrets and resolve GH_TOKEN before calling `gh` — the
      // routed-dispatch path does this later inside the executable
      // pipeline, but the unrecognized-token path bypasses that and would
      // otherwise hit the "set GH_TOKEN" error from the gh CLI.
      try {
        unpackAllSecrets()
        resolveAuthToken()
      } catch {
        /* best-effort — postIssueComment will surface the failure if auth is unusable */
      }
      const tokenLabel = outcome.token ? `\`${outcome.token}\`` : "an empty subcommand"
      const top = outcome.available.slice(0, 12).join(", ")
      const more = outcome.available.length > 12 ? `, … (${outcome.available.length - 12} more)` : ""
      const body = [
        `⚠️ kody: I don't recognize ${tokenLabel}.`,
        "",
        `Available subcommands: ${top}${more}`,
        "",
        "Examples: `@kody`, `@kody fix`, `@kody plan`, `@kody review`.",
      ].join("\n")
      try {
        if (outcome.isPr) ghPostPrReviewComment(outcome.target, body, cwd)
        else ghPostIssueComment(outcome.target, body, cwd)
      } catch (err) {
        process.stderr.write(`[kody] dispatch: failed to post unrecognized-token feedback: ${err instanceof Error ? err.message : String(err)}\n`)
      }
      process.stdout.write(
        `→ kody: unrecognized subcommand "${outcome.token}" on #${outcome.target} — feedback comment attempt finished, exiting cleanly\n`,
      )
      return 0
    }
    process.stdout.write(`→ kody: no action for event ${process.env.GITHUB_EVENT_NAME} — exiting cleanly\n`)
    return 0
  }

  if (!args.issueNumber && !autoFallback) {
    // Neither explicit flag nor detectable event — keep the original error.
  } else {
    // Suppress "--issue required" error when autoDispatch resolved it.
    args.errors = args.errors.filter((e) => !e.includes("--issue"))
  }
  if (args.errors.length > 0 && !args.errors.includes("__HELP__")) {
    for (const e of args.errors) process.stderr.write(`error: ${e}\n`)
    process.stderr.write(`\n${CI_HELP}`)
    return 64
  }

  const dispatch = autoFallback ?? {
    executable: "run" as const,
    cliArgs: { issue: args.issueNumber! } as Record<string, unknown>,
    target: args.issueNumber!,
  }
  const issueNumber = dispatch.target

  process.stdout.write(`→ kody preflight (cwd=${cwd}, executable=${dispatch.executable}, target=${issueNumber})\n`)

  try {
    const n = unpackAllSecrets()
    if (n > 0) process.stdout.write(`→ kody: unpacked ${n} secret(s) from ALL_SECRETS\n`)
    resolveAuthToken()
    // Acknowledge the triggering @kody comment with 👀 so the user sees
    // kody picked up the request before deps/model spin up.
    reactToTriggerComment(cwd)

    const pm = args.packageManager ?? detectPackageManager(cwd)
    process.stdout.write(`→ kody: package manager = ${pm}\n`)

    if (!args.skipInstall) {
      const code = installDeps(pm, cwd)
      if (code !== 0) {
        postFailureTail(issueNumber, cwd, `dependency install failed (${pm}, exit ${code})`)
        return 99
      }
    } else {
      process.stdout.write("→ kody: skipping dep install (--skip-install)\n")
    }

    if (!args.skipLitellm) {
      const code = installLitellmIfNeeded(cwd)
      if (code !== 0) {
        postFailureTail(issueNumber, cwd, `litellm install failed (exit ${code})`)
        return 99
      }
    } else {
      process.stdout.write("→ kody: skipping LiteLLM install (--skip-litellm)\n")
    }

    configureGitIdentity(cwd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody] preflight crashed: ${msg}\n`)
    postFailureTail(issueNumber, cwd, `preflight crashed: ${msg}`)
    return 99
  }

  process.stdout.write(`→ kody: preflight done, handing off to kody ${dispatch.executable}\n\n`)

  try {
    const config = earlyConfig ?? loadConfig(cwd)
    const result = await runExecutable(dispatch.executable, {
      cliArgs: dispatch.cliArgs,
      cwd,
      config,
      verbose: args.verbose,
      quiet: args.quiet,
    })
    if (result.exitCode !== 0 && result.exitCode !== 1 && result.exitCode !== 2) {
      // Only post tail on non-draft-PR failures; draft PRs already carry the failure body.
      postFailureTail(issueNumber, cwd, result.reason || `exit ${result.exitCode}`)
    }
    return result.exitCode
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody] run crashed: ${msg}\n`)
    if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
    postFailureTail(issueNumber, cwd, `run crashed: ${msg}`)
    return 99
  }
}

/**
 * Run every watch executable whose `schedule` matches the wake window.
 * Shares the same preflight (secret unpack, dep install, litellm, git
 * identity) as the single-target path; runs each match sequentially.
 * Aggregate exit code: 0 iff every watch returned 0.
 */
async function runScheduledFanOut(cwd: string, args: CiArgs, opts: { force: boolean }): Promise<number> {
  const matches: DispatchResult[] = dispatchScheduledWatches({ force: opts.force })
  if (matches.length === 0) {
    process.stdout.write(
      `→ kody: scheduled wake — no watches matched ${opts.force ? "(force mode, no watches discovered)" : "(window)"}, exiting cleanly\n`,
    )
    return 0
  }

  const names = matches.map((m) => m.executable).join(", ")
  process.stdout.write(`→ kody: scheduled wake — firing ${matches.length} watch(es): ${names}\n`)

  try {
    const n = unpackAllSecrets()
    if (n > 0) process.stdout.write(`→ kody: unpacked ${n} secret(s) from ALL_SECRETS\n`)
    resolveAuthToken()

    const pm = args.packageManager ?? detectPackageManager(cwd)
    process.stdout.write(`→ kody: package manager = ${pm}\n`)

    if (!args.skipInstall) {
      const code = installDeps(pm, cwd)
      if (code !== 0) {
        process.stderr.write(`[kody] dep install failed (${pm}, exit ${code})\n`)
        return 99
      }
    }
    if (!args.skipLitellm) {
      const code = installLitellmIfNeeded(cwd)
      if (code !== 0) {
        process.stderr.write(`[kody] litellm install failed (exit ${code})\n`)
        return 99
      }
    }
    configureGitIdentity(cwd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody] preflight crashed: ${msg}\n`)
    return 99
  }

  const config = loadConfig(cwd)
  // Parallel watch fanout — typical wake fires 2–3 independent watches
  // (job-scheduler, goal-scheduler, watch-stale-prs) that operate on
  // disjoint targets and don't share working-tree state. Running them
  // sequentially makes the second one wait through MCP boot + agent
  // turns of the first for no reason. Aggregate via allSettled so one
  // crash doesn't strand the rest. Set `KODY_SERIAL_WATCHES=1` to
  // restore the legacy behaviour while the new mode bakes in.
  const serial = process.env.KODY_SERIAL_WATCHES === "1"
  const runWatch = async (match: DispatchResult): Promise<number> => {
    process.stdout.write(`\n→ kody: running watch \`${match.executable}\`\n`)
    try {
      const result = await runExecutable(match.executable, {
        cliArgs: match.cliArgs,
        cwd,
        config,
        verbose: args.verbose,
        quiet: args.quiet,
      })
      if (result.exitCode !== 0) {
        process.stderr.write(
          `[kody] watch \`${match.executable}\` exited ${result.exitCode}: ${result.reason ?? "(no reason)"}\n`,
        )
        return result.exitCode
      }
      return 0
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody] watch \`${match.executable}\` crashed: ${msg}\n`)
      return 99
    }
  }

  let worstExit = 0
  if (serial) {
    for (const match of matches) {
      const code = await runWatch(match)
      if (code > worstExit) worstExit = code
    }
  } else {
    const settled = await Promise.allSettled(matches.map((m) => runWatch(m)))
    for (const r of settled) {
      const code = r.status === "fulfilled" ? r.value : 99
      if (code > worstExit) worstExit = code
    }
  }
  return worstExit
}
