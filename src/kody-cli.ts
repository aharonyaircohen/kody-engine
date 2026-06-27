import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { mintAppInstallationToken, readAppCreds } from "./app-auth.js"
import { loadConfig, needsLitellmProxy, parseProviderModel } from "./config.js"
import { autoDispatch, autoDispatchTyped, type DispatchResult, dispatchScheduledWatches } from "./dispatch.js"
import { reactToTriggerComment } from "./gha.js"
import {
  postIssueComment as ghPostIssueComment,
  postPrReviewComment as ghPostPrReviewComment,
  postIssueComment,
  truncate,
} from "./issue.js"
import { mintInstantJob, mintScheduledJob, runJob } from "./job.js"
import { resolveCapabilityAction } from "./registry.js"
import { lastRunLogPath } from "./runtimePaths.js"
import { hydrateStateWorkspace } from "./stateWorkspace.js"
import { readRunRequestFromEnv, type RunRequest } from "./run-request.js"

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
  kody ci [--issue <N>] [--cwd <path>] [--verbose|--quiet]
           [--skip-install] [--skip-litellm] [--package-manager pnpm|yarn|bun|npm]

Options:
  --issue <N>          GitHub issue number to work on (legacy explicit route; optional in CI)
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

type RunRequestRoute =
  | { kind: "action"; action: string; cliArgs: Record<string, unknown> }
  | { kind: "fanout"; force: boolean }
  | { kind: "ignore" }
  | { kind: "error"; error: string }

function routeRunRequest(request: RunRequest): RunRequestRoute {
  const { target, intent } = request
  if (target.type === "chat" || target.type === "issue") return { kind: "ignore" }

  if (target.type === "goal") {
    if (intent !== "manage" && intent !== "run" && intent !== "tick") {
      return { kind: "error", error: `goal target does not support intent '${intent}'` }
    }
    return {
      kind: "action",
      action: "goal-manager",
      cliArgs: { goal: target.id },
    }
  }

  if (target.type === "workflow") {
    if (target.id === "scheduled-fanout") {
      return { kind: "fanout", force: intent === "run" }
    }
    if (intent !== "run" && intent !== "tick") {
      return { kind: "error", error: `workflow target does not support intent '${intent}'` }
    }
    return { kind: "action", action: target.id, cliArgs: {} }
  }

  return { kind: "error", error: "unsupported run request target" }
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

function recoverCheckoutToken(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | undefined {
  if (env.GITHUB_TOKEN?.trim()) return env.GITHUB_TOKEN.trim()
  let header = ""
  try {
    header = execFileSync("git", ["config", "--local", "--get", "http.https://github.com/.extraheader"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return undefined
  }
  const match = /^AUTHORIZATION:\s+basic\s+(.+)$/i.exec(header)
  if (!match) return undefined
  const decoded = Buffer.from(match[1]!, "base64").toString("utf-8")
  const token = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1).trim() : decoded.trim()
  if (!token) return undefined
  env.GITHUB_TOKEN = token
  process.stdout.write("→ kody: GITHUB_TOKEN recovered from actions/checkout credentials\n")
  return token
}

export async function resolveAuthToken(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  // App credentials are the modern Kody auth path. Prefer minting here over
  // a workflow-provided token because the workflow token may only cover the
  // current repo, while Kody state can live in a sibling repo.
  const creds = readAppCreds(env)
  if (creds) {
    try {
      const minted = await mintAppInstallationToken(creds)
      env.GH_TOKEN = minted
      recoverCheckoutToken(env)
      process.stdout.write("→ kody: GH_TOKEN minted from GitHub App (KODY_APP_ID/KODY_APP_PRIVATE_KEY)\n")
      return minted
    } catch (err) {
      process.stdout.write(`→ kody: WARNING GitHub App token mint failed: ${(err as Error).message}\n`)
    }
  }

  const sources: Array<[string, string | undefined]> = [
    ["KODY_TOKEN", env.KODY_TOKEN],
    ["GH_TOKEN", env.GH_TOKEN],
    ["GITHUB_TOKEN", env.GITHUB_TOKEN],
    ["GH_PAT", env.GH_PAT],
  ]
  const picked = sources.find(([, v]) => !!v)
  const token = picked?.[1]
  if (token && !env.GH_TOKEN) env.GH_TOKEN = token
  recoverCheckoutToken(env)
  if (token) {
    // Log only which env var the token came from — no length/prefix/hash
    // (that was temporary diagnostics for the kodyade throttle hunt).
    process.stdout.write(`→ kody: GH_TOKEN sourced from env.${picked![0]}\n`)
    return token
  }

  process.stdout.write(
    "→ kody: WARNING no auth token found (KODY_TOKEN/GH_TOKEN/GITHUB_TOKEN/GH_PAT/GitHub App all empty)\n",
  )
  return undefined
}

export function detectPackageManager(cwd: string): PackageManager {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm"
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn"
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun"
  return "npm"
}

function shouldChainScheduledWatch(match: DispatchResult): boolean {
  return (
    match.action === "goal-scheduler" ||
    match.capability === "goal-scheduler" ||
    match.executable === "goal-scheduler"
  )
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
  const logPath = lastRunLogPath(cwd)
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
  // Load config early so autoDispatch can consult legacy default capability action keys.
  let earlyConfig: ReturnType<typeof loadConfig> | undefined
  let earlyConfigError: Error | undefined
  try {
    earlyConfig = loadConfig(cwd)
    hydrateStateWorkspace(earlyConfig, cwd)
  } catch (err) {
    earlyConfigError = err instanceof Error ? err : new Error(String(err))
  }

  // --issue is only required when autoDispatch can't infer from GHA env.
  const autoFallback = !args.issueNumber ? autoDispatch({ config: earlyConfig }) : null

  // Schedule wakes and parameterless workflow_dispatch fan out to every
  // watch executable whose `schedule` cron matches the wake window
  // (workflow_dispatch ignores the cron — it's an explicit "fire all").
  // capability-scheduler is itself a watch and continues to fire from this
  // path; nightly suites and any future watch executables join naturally,
  // no kody.yml or config edits.
  const eventName = process.env.GITHUB_EVENT_NAME
  const dispatchEventPath = process.env.GITHUB_EVENT_PATH
  let manualWorkflowDispatch = false
  let forceRunAction: string | null = null
  let forceRunCliArgs: Record<string, unknown> = {}
  let runRequestFanOut = false
  let runRequestFanOutForce = false
  const parsedRunRequest = readRunRequestFromEnv()
  if (parsedRunRequest && "error" in parsedRunRequest) {
    process.stderr.write(`[kody] ${parsedRunRequest.error}\n`)
    return 64
  }
  if (!args.issueNumber && !autoFallback && parsedRunRequest && "request" in parsedRunRequest) {
    const route = routeRunRequest(parsedRunRequest.request)
    if (route.kind === "error") {
      process.stderr.write(`[kody] ${route.error}\n`)
      return 64
    }
    if (route.kind === "fanout") {
      runRequestFanOut = true
      runRequestFanOutForce = route.force
    } else if (route.kind === "action") {
      forceRunAction = route.action
      forceRunCliArgs = route.cliArgs
    }
  }
  const envForceAction = (process.env.KODY_FORCE_ACTION ?? "").trim()
  const envForceMessage = (process.env.KODY_FORCE_MESSAGE ?? "").trim()
  if (!args.issueNumber && !autoFallback && !forceRunAction && !runRequestFanOut && envForceAction) {
    forceRunAction = envForceAction
    if (envForceAction === "goal-manager" && envForceMessage) {
      forceRunCliArgs = { goal: envForceMessage }
    }
  }
  if (
    !args.issueNumber &&
    !autoFallback &&
    !forceRunAction &&
    !runRequestFanOut &&
    eventName === "workflow_dispatch" &&
    dispatchEventPath &&
    fs.existsSync(dispatchEventPath)
  ) {
    try {
      const evt = JSON.parse(fs.readFileSync(dispatchEventPath, "utf-8"))
      const issueInput = parseInt(String(evt?.inputs?.issue_number ?? ""), 10)
      const sessionInput = String(evt?.inputs?.sessionId ?? "")
      const dutyInput = String(evt?.inputs?.capability ?? evt?.inputs?.executable ?? "").trim()
      const messageInput = String(evt?.inputs?.message ?? "").trim()
      const noTarget = !sessionInput && !(Number.isFinite(issueInput) && issueInput > 0)
      // Explicit `capability` + no target → manual one-shot "Run now" of that
      // single capability (a scheduled / no-target folder-capability), bypassing the
      // cadence guard. A bare dispatch (no capability) still fans out to every
      // watch capability (capability-scheduler et al.).
      if (noTarget && dutyInput) {
        forceRunAction = dutyInput
        if (dutyInput === "goal-manager" && messageInput) {
          forceRunCliArgs = { goal: messageInput }
        }
      } else {
        manualWorkflowDispatch = noTarget
      }
    } catch {
      manualWorkflowDispatch = false
    }
  }
  if (forceRunAction) {
    const config = earlyConfig ?? loadConfig(cwd)
    const manualGoalManager = forceRunAction === "goal-manager"
    const dutyRoute = manualGoalManager ? null : resolveCapabilityAction(forceRunAction)
    const scheduledWatchRoute =
      manualGoalManager || dutyRoute
        ? undefined
        : dispatchScheduledWatches({ force: true }).find(
            (match) => match.action === forceRunAction || match.executable === forceRunAction,
          )
    const route = manualGoalManager
      ? {
          action: "goal-manager",
          capability: "goal-manager",
          executable: "goal-manager",
          cliArgs: forceRunCliArgs,
        }
      : (dutyRoute ?? scheduledWatchRoute)
    if (!route) {
      process.stderr.write(`[kody] manual one-shot action '${forceRunAction}' has no capability action\n`)
      return 64
    }
    if (route.executable === "goal-manager" && typeof forceRunCliArgs.goal !== "string") {
      process.stderr.write("[kody] manual goal-manager run requires message goal id\n")
      return 64
    }
    process.stdout.write(`→ kody: manual one-shot run action ${route.action} (${route.capability})\n\n`)
    try {
      // Same preflight as the routed path: secrets, auth, deps, LiteLLM, git.
      // Without this the capability's agent has no LiteLLM proxy (non-Anthropic
      // models) and no installed consumer deps.
      const n = unpackAllSecrets()
      if (n > 0) process.stdout.write(`→ kody: unpacked ${n} secret(s)\n`)
      await resolveAuthToken()
      const pm = args.packageManager ?? detectPackageManager(cwd)
      if (!args.skipInstall) {
        const code = installDeps(pm, cwd)
        if (code !== 0) {
          process.stderr.write(`[kody] dependency install failed (exit ${code})\n`)
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
      process.stderr.write(`[kody] manual capability preflight crashed: ${String(err)}\n`)
      return 99
    }
    const result = await runJob(
      {
        action: route.action,
        capability: route.capability,
        executable: route.executable,
        cliArgs: { ...route.cliArgs, ...forceRunCliArgs },
        flavor: "instant",
        force: true,
      },
      {
        cwd,
        config,
        verbose: args.verbose,
        quiet: args.quiet,
      },
    )
    const ec = result.exitCode
    return ec === 0 || ec === 1 || ec === 2 ? ec : 99
  }
  if (!args.issueNumber && !autoFallback && runRequestFanOut) {
    return runScheduledFanOut(cwd, args, { force: runRequestFanOutForce })
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
        await resolveAuthToken()
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
        "Examples: `@kody`, `@kody run`, `@kody resolve`, `@kody sync`.",
      ].join("\n")
      try {
        if (outcome.isPr) ghPostPrReviewComment(outcome.target, body, cwd)
        else ghPostIssueComment(outcome.target, body, cwd)
      } catch (err) {
        process.stderr.write(
          `[kody] dispatch: failed to post unrecognized-token feedback: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
      process.stdout.write(
        `→ kody: unrecognized subcommand "${outcome.token}" on #${outcome.target} — feedback comment attempt finished, exiting cleanly\n`,
      )
      return 0
    }
    if (
      outcome.kind === "silent" &&
      earlyConfigError &&
      outcome.reason.includes("no default capability action configured")
    ) {
      process.stderr.write(`[kody] config error: ${earlyConfigError.message}\n`)
      return 64
    }
    process.stdout.write(`→ kody: no action for event ${process.env.GITHUB_EVENT_NAME} — checking scheduled watches\n`)
    return runScheduledFanOut(cwd, args, { force: false })
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

  const runRoute = args.issueNumber ? resolveCapabilityAction("run") : null
  if (!autoFallback && args.issueNumber && !runRoute) {
    process.stderr.write("[kody] required capability action 'run' not found\n")
    return 64
  }
  const dispatch = autoFallback ?? {
    ...runRoute!,
    cliArgs: { ...runRoute!.cliArgs, issue: args.issueNumber! } as Record<string, unknown>,
    target: args.issueNumber!,
  }
  const issueNumber = dispatch.target

  process.stdout.write(
    `→ kody preflight (cwd=${cwd}, action=${dispatch.action}, capability=${dispatch.capability}, executable=${dispatch.executable}, target=${issueNumber})\n`,
  )

  try {
    const n = unpackAllSecrets()
    if (n > 0) process.stdout.write(`→ kody: unpacked ${n} secret(s) from ALL_SECRETS\n`)
    await resolveAuthToken()
    // Acknowledge the triggering @kody comment with 👀 so the user sees
    // kody picked up the request before deps/model spin up.
    reactToTriggerComment(cwd)

    const pm = args.packageManager ?? detectPackageManager(cwd)
    process.stdout.write(`→ kody: package manager = ${pm}\n`)

    // preview-build compiles the consumer app *inside* docker (deps go in
    // the image) and runs no model — so the runner needs neither the
    // consumer's node_modules nor the LiteLLM proxy. Skipping both trims
    // ~1–2 min of otherwise-wasted preflight on the preview path.
    const buildOnly = dispatch.executable === "preview-build"

    if (args.skipInstall || buildOnly) {
      process.stdout.write(
        `→ kody: skipping dep install (${buildOnly ? "build-only executable" : "--skip-install"})\n`,
      )
    } else {
      const code = installDeps(pm, cwd)
      if (code !== 0) {
        postFailureTail(issueNumber, cwd, `dependency install failed (${pm}, exit ${code})`)
        return 99
      }
    }

    if (args.skipLitellm || buildOnly) {
      process.stdout.write(
        `→ kody: skipping LiteLLM install (${buildOnly ? "build-only executable" : "--skip-litellm"})\n`,
      )
    } else {
      const code = installLitellmIfNeeded(cwd)
      if (code !== 0) {
        postFailureTail(issueNumber, cwd, `litellm install failed (exit ${code})`)
        return 99
      }
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
    // runExecutableChain follows any in-process stage hand-offs (classify →
    // build, flow ping-pong, goal-manager -> capability pipeline) so a stage never has
    // to post a bot-authored `@kody` comment the follow-up run would ignore.
    // One-runner: the comment / manual route mints an INSTANT job and runs it.
    // runJob wraps runExecutableChain, so in-process stage hand-offs and exit
    // codes are preserved. The minted job carries the default `kody` agent
    // (executor injects it) and the operator's verbatim request as `why`
    // (carried on the DispatchResult → surfaced as a fenced system block).
    const result = await runJob(mintInstantJob(dispatch), {
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
 * Run every watch capability whose executable's `schedule` matches the wake window.
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

  const names = matches.map((m) => `${m.capability}→${m.executable}`).join(", ")
  process.stdout.write(`→ kody: scheduled wake — firing ${matches.length} watch capability/ies: ${names}\n`)

  try {
    const n = unpackAllSecrets()
    if (n > 0) process.stdout.write(`→ kody: unpacked ${n} secret(s) from ALL_SECRETS\n`)
    await resolveAuthToken()

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
  // (capability-scheduler, goal-scheduler, and future watches) that operate on
  // disjoint targets and don't share working-tree state. Running them
  // sequentially makes the second one wait through MCP boot + agent
  // turns of the first for no reason. Aggregate via allSettled so one
  // crash doesn't strand the rest. Set `KODY_SERIAL_WATCHES=1` to
  // restore the legacy behaviour while the new mode bakes in.
  const serial = process.env.KODY_SERIAL_WATCHES === "1"
  const runWatch = async (match: DispatchResult): Promise<number> => {
    process.stdout.write(
      `\n→ kody: running watch capability \`${match.capability}\` (${match.executable})\n`,
    )
    try {
      const result = await runJob(
        mintScheduledJob({
          action: match.action,
          capability: match.capability,
          executable: match.executable,
          cliArgs: match.cliArgs,
        }),
        {
          cwd,
          config,
          verbose: args.verbose,
          quiet: args.quiet,
          chain: shouldChainScheduledWatch(match),
        },
      )
      if (result.exitCode !== 0) {
        process.stderr.write(
          `[kody] watch capability \`${match.capability}\` exited ${result.exitCode}: ${result.reason ?? "(no reason)"}\n`,
        )
        return result.exitCode
      }
      return 0
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody] watch capability \`${match.capability}\` crashed: ${msg}\n`)
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
