import pkg from "../package.json"
import { brainProxy } from "./bin/brain-proxy.js"
import { mcpHttpServer } from "./bin/mcp-http-server.js"
import { runChat } from "./chat-cli.js"
import { loadConfig } from "./config.js"
import { runExecutableChain } from "./executor.js"
import { runCi } from "./kody-cli.js"
import { runJob } from "./job.js"
import {
  hasDutyAction,
  hasExecutable,
  listDutyActions,
  listExecutables,
  parseGenericFlags,
  resolveDutyAction,
} from "./registry.js"
import { brainServe } from "./servers/brain-serve.js"
import { poolServe } from "./servers/pool-serve.js"
import { runnerServe } from "./servers/runner-serve.js"
import { serve } from "./servers/serve.js"
import { runStats } from "./stats.js"

interface ParsedArgs {
  command: "ci" | "chat" | "help" | "version" | "stats" | "server" | "__duty__" | "__executable__"
  actionName?: string
  executableName?: string
  serverName?: "serve" | "pool-serve" | "runner-serve" | "brain-serve" | "brain-proxy" | "mcp-http-server"
  serverArgs?: string[]
  cliArgs?: Record<string, unknown>
  cwd?: string
  verbose?: boolean
  quiet?: boolean
  errors: string[]
  ciArgv?: string[]
  chatArgv?: string[]
  statsArgv?: string[]
}

const HELP_TEXT = `kody-engine — single-session autonomous engineer

Usage:
  kody-engine run     --issue <N> [--cwd <path>] [--verbose|--quiet]
  kody-engine resolve --pr    <N>                    [--cwd <path>] [--verbose|--quiet]
  kody-engine sync    --pr    <N>                    [--cwd <path>] [--verbose|--quiet]
  kody-engine merge   --pr    <N>                    [--cwd <path>] [--verbose|--quiet]
  kody-engine revert  --pr    <N> --shas <sha...>    [--cwd <path>] [--verbose|--quiet]
  kody-engine preview-build --pr <N>                 [--cwd <path>] [--verbose|--quiet]
  kody-engine release --issue <N>                    [--cwd <path>] [--verbose|--quiet]
  kody-engine init                                   [--cwd <path>] [--verbose|--quiet]
  kody-engine <action>                               [--cwd <path>] [--verbose|--quiet]
  kody-engine exec <executable>                      [--cwd <path>] [--verbose|--quiet]
  kody-engine ci      [preflight flags — see: kody-engine ci --help]
  kody-engine chat    [chat flags — see: kody-engine chat --help]
  kody-engine stats   [--since 7d|--run <id>|--json|--cwd <path>]
  kody-engine help
  kody-engine version

Top-level work commands are duty actions. A duty owns the public action name
and selects an implementation executable. \`exec <executable>\` is the low-level
debug path for engine internals and migration compatibility.

Exit codes:
  0   success (PR opened, verify passed — or resolve produced a merge commit)
  1   agent reported FAILED (draft PR opened)
  2   verify failed (no PR opened — branch pushed for inspection) — skipped in resolve mode
  3   no commits to ship (also the resolve clean-merge short-circuit)
  4   PR creation failed
  64  invalid CLI args
  99  wrapper crashed
  124 a preflight/postflight shell script exceeded its timeout
`

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { command: "help", errors: [] }

  // No verb: auto-route by env so the consumer workflow can invoke a bare
  // `kody` instead of branching in shell. SESSION_ID is the chat signal
  // (wired from the dashboard's workflow_dispatch input); otherwise fall
  // through to ci for agent/job/pull_request/schedule triggers.
  if (argv.length === 0) {
    if (process.env.SESSION_ID) return { ...result, command: "chat", chatArgv: [] }
    if (process.env.GITHUB_EVENT_NAME) return { ...result, command: "ci", ciArgv: [] }
    return result
  }

  const cmd = argv[0]!
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return { ...result, command: "help" }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") return { ...result, command: "version" }
  if (cmd === "ci") {
    return { ...result, command: "ci", ciArgv: argv.slice(1) }
  }
  if (cmd === "chat") {
    return { ...result, command: "chat", chatArgv: argv.slice(1) }
  }
  if (cmd === "stats") {
    return { ...result, command: "stats", statsArgv: argv.slice(1) }
  }

  // Long-running servers are engine plumbing, not user work-verbs. They route
  // to src/servers/ as hardcoded CLI verbs (like ci/help/version), so the
  // executable registry never lists them and dispatch never treats them as verbs.
  const SERVER_VERBS = new Set(["serve", "pool-serve", "runner-serve", "brain-serve", "brain-proxy", "mcp-http-server"])
  if (SERVER_VERBS.has(cmd)) {
    result.command = "server"
    result.serverName = cmd as ParsedArgs["serverName"]
    const flags = parseGenericFlags(argv.slice(1))
    if (typeof flags.cwd === "string") result.cwd = flags.cwd
    if (flags.verbose === true) result.verbose = true
    // Positional tokens (e.g. `kody serve vscode|claude`) — flags are handled above.
    result.serverArgs = argv.slice(1).filter((a) => !a.startsWith("-"))
    return result
  }

  if (cmd === "exec") {
    const executableName = argv[1]
    if (!executableName) {
      result.errors.push("exec requires an executable name")
      return result
    }
    if (!hasExecutable(executableName)) {
      result.errors.push(`unknown executable: ${executableName}`)
      return result
    }
    result.command = "__executable__"
    result.executableName = executableName
    result.cliArgs = parseGenericFlags(argv.slice(2))
    if (typeof result.cliArgs.cwd === "string") result.cwd = result.cliArgs.cwd
    if (result.cliArgs.verbose === true) result.verbose = true
    if (result.cliArgs.quiet === true) result.quiet = true
    return result
  }

  // Public top-level work commands are duty actions. Keep the older direct
  // executable path after this for internal tools such as goal-tick.
  if (hasDutyAction(cmd)) {
    result.command = "__duty__"
    result.actionName = cmd
    result.cliArgs = parseGenericFlags(argv.slice(1))
    if (typeof result.cliArgs.cwd === "string") result.cwd = result.cliArgs.cwd
    if (result.cliArgs.verbose === true) result.verbose = true
    if (result.cliArgs.quiet === true) result.quiet = true
    return result
  }

  // Internal/back-compat direct executable path (goal-tick, schedulers, tests).
  if (hasExecutable(cmd)) {
    result.command = "__executable__"
    result.executableName = cmd
    result.cliArgs = parseGenericFlags(argv.slice(1))
    if (typeof result.cliArgs.cwd === "string") result.cwd = result.cliArgs.cwd
    if (result.cliArgs.verbose === true) result.verbose = true
    if (result.cliArgs.quiet === true) result.quiet = true
    return result
  }

  const discoveredActions = listDutyActions().map((e) => e.action)
  const discoveredExecutables = listExecutables().map((e) => `exec ${e.name}`)
  const available = ["ci", "chat", "stats", "help", "version", ...discoveredActions, ...discoveredExecutables]
  result.errors.push(`unknown command: ${cmd} (available: ${available.join(", ")})`)
  return result
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)

  if (args.errors.length > 0) {
    for (const e of args.errors) process.stderr.write(`error: ${e}\n`)
    process.stderr.write(`\n${HELP_TEXT}`)
    return 64
  }
  if (args.command === "help") {
    process.stdout.write(HELP_TEXT)
    return 0
  }
  if (args.command === "version") {
    process.stdout.write(`kody ${pkg.version}\n`)
    return 0
  }
  if (args.command === "ci") {
    try {
      return await runCi(args.ciArgv ?? [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody] fatal: ${msg}\n`)
      if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
      return 99
    }
  }
  if (args.command === "chat") {
    try {
      return await runChat(args.chatArgv ?? [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody] fatal: ${msg}\n`)
      if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
      return 99
    }
  }
  if (args.command === "stats") {
    try {
      return await runStats(args.statsArgv ?? [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody] fatal: ${msg}\n`)
      if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
      return 99
    }
  }

  if (args.command === "server") {
    const cwd = args.cwd ?? process.cwd()
    try {
      switch (args.serverName) {
        case "serve":
          return await serve({ cwd, config: loadConfig(cwd), args: args.serverArgs ?? [] })
        case "pool-serve":
          return await poolServe()
        case "runner-serve":
          return await runnerServe()
        case "brain-serve":
          return await brainServe({ cwd })
        case "brain-proxy":
          return await brainProxy()
        case "mcp-http-server":
          return await mcpHttpServer()
        default:
          process.stderr.write(`error: unknown server '${args.serverName}'\n`)
          return 64
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody] ${args.serverName} crashed: ${msg}\n`)
      if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
      return 99
    }
  }

  const cwd = args.cwd ?? process.cwd()

  // Configless implementations: skip config load.
  // - init runs BEFORE a kody.config.json exists.
  // - goal-scheduler is a scan-only lifecycle tool: walks `.kody/goals/*`
  //   and dispatches a goal-tick subprocess for each active goal. No
  //   config use of its own.
  //
  // goal-tick IS NOT configless — it needs config.git.defaultBranch to
  // resolve the base for the first task in a stacked-PR run. The
  // configless fallback in executor.ts hardcodes "main", which is wrong
  // for repos defaulting to `dev`, `master`, etc. and silently collapsed
  // the stack onto the wrong branch.
  const configlessCommands = new Set(["init", "goal-scheduler"])

  if (args.command === "__duty__") {
    const route = resolveDutyAction(args.actionName!)
    if (!route) {
      process.stderr.write(`error: unknown duty action '${args.actionName}'\n`)
      return 64
    }
    const cliArgs = { ...route.cliArgs, ...(args.cliArgs ?? {}) }
    const skipConfig = configlessCommands.has(route.executable)
    try {
      const result = await runJob(
        {
          action: route.action,
          duty: route.duty,
          executable: route.executable,
          cliArgs,
          target: numericTarget(cliArgs),
          flavor: "instant",
        },
        {
          cwd,
          skipConfig,
          verbose: args.verbose,
          quiet: args.quiet,
        },
      )
      if (result.exitCode !== 0 && result.reason) {
        process.stderr.write(`error: ${result.reason}\n`)
      }
      return result.exitCode
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody] ${args.actionName} crashed: ${msg}\n`)
      if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
      process.stdout.write(`PR_URL=FAILED: ${args.actionName} crashed: ${msg}\n`)
      return 99
    }
  }

  const skipConfig = configlessCommands.has(args.executableName ?? "")

  try {
    // runExecutableChain so an explicitly-invoked stage follows its in-process
    // hand-offs too — notably `goal-scheduler` shells out to
    // `kody-engine goal-tick`, whose dispatchNextTask hands the task pipeline
    // off via nextDispatch; without chaining here the goal would never build.
    const result = await runExecutableChain(args.executableName!, {
      cliArgs: args.cliArgs ?? {},
      cwd,
      skipConfig,
      verbose: args.verbose,
      quiet: args.quiet,
    })
    if (result.exitCode !== 0 && result.reason) {
      process.stderr.write(`error: ${result.reason}\n`)
    }
    return result.exitCode
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody] ${args.executableName} crashed: ${msg}\n`)
    if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
    process.stdout.write(`PR_URL=FAILED: ${args.executableName} crashed: ${msg}\n`)
    return 99
  }
}

function numericTarget(cliArgs: Record<string, unknown>): number | undefined {
  for (const key of ["issue", "pr"]) {
    const raw = cliArgs[key]
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : Number.NaN
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}
