import pkg from "../package.json"
import { brainProxy } from "./bin/brain-proxy.js"
import { mcpHttpServer } from "./bin/mcp-http-server.js"
import { runChat } from "./chat-cli.js"
import { loadConfig } from "./config.js"
import { runJob } from "./job.js"
import { runCi } from "./kody-cli.js"
import {
  hasCapabilityAction,
  listCapabilityActions,
  parseGenericFlags,
  resolveCapabilityAction,
  resolveExecutable,
} from "./registry.js"
import { readRunRequestFromEnv } from "./run-request.js"
import { brainServe } from "./servers/brain-serve.js"
import { poolServe } from "./servers/pool-serve.js"
import { runnerServe } from "./servers/runner-serve.js"
import { serve } from "./servers/serve.js"
import { runStats } from "./stats.js"

interface ParsedArgs {
  command: "ci" | "chat" | "help" | "version" | "stats" | "server" | "__capability__" | "__exec__"
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

function envRunMode(env: NodeJS.ProcessEnv = process.env): ParsedArgs | null {
  const result: ParsedArgs = { command: "help", errors: [] }
  const mode = (env.KODY_RUN_MODE ?? "").trim().toLowerCase()
  if (!mode) return null

  if (mode === "chat" || mode === "interactive") {
    return { ...result, command: "chat", chatArgv: [] }
  }
  if (mode === "ci" || mode === "scheduled" || mode === "manual") {
    return { ...result, command: "ci", ciArgv: [] }
  }
  if (mode === "issue") {
    const issue = (env.ISSUE_NUMBER ?? "").trim()
    if (!issue) {
      return { ...result, errors: ["KODY_RUN_MODE=issue requires ISSUE_NUMBER"] }
    }
    return { ...result, command: "ci", ciArgv: ["--issue", issue] }
  }

  return { ...result, errors: [`unknown KODY_RUN_MODE: ${mode}`] }
}

function envRunRequest(env: NodeJS.ProcessEnv = process.env): ParsedArgs | null {
  const result: ParsedArgs = { command: "help", errors: [] }
  const parsed = readRunRequestFromEnv(env)
  if (!parsed) return null
  if ("error" in parsed) return { ...result, errors: [parsed.error] }

  const { target } = parsed.request
  if (target.type === "chat") return { ...result, command: "chat", chatArgv: [] }
  if (target.type === "issue") return { ...result, command: "ci", ciArgv: ["--issue", String(target.id)] }
  if (target.type === "goal" || target.type === "workflow") return { ...result, command: "ci", ciArgv: [] }

  return { ...result, errors: [`unsupported runRequest target: ${(target as { type?: string }).type ?? "unknown"}`] }
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

Top-level work commands are capabilities. A capability owns the public command name
and resolves the implementation that runs it. Use exec only for internal implementation
profiles and legacy scheduled helpers.

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

  // No verb: auto-route by env so every runner can invoke bare `kody`.
  // KODY_RUN_REQUEST_JSON is the canonical contract. KODY_RUN_MODE,
  // SESSION_ID, and GITHUB_EVENT_NAME stay as compatibility fallbacks.
  if (argv.length === 0) {
    const runRequest = envRunRequest()
    if (runRequest) return runRequest
    const mode = envRunMode()
    if (mode) return mode
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

  if (cmd === "exec") {
    const executableName = argv[1]
    if (!executableName || executableName.startsWith("-")) {
      result.errors.push("exec requires an executable name")
      return result
    }
    if (!resolveExecutable(executableName)) {
      result.errors.push(`unknown executable: ${executableName}`)
      return result
    }
    result.command = "__exec__"
    result.executableName = executableName
    result.cliArgs = parseGenericFlags(argv.slice(2))
    if (typeof result.cliArgs.cwd === "string") result.cwd = result.cliArgs.cwd
    if (result.cliArgs.verbose === true) result.verbose = true
    if (result.cliArgs.quiet === true) result.quiet = true
    return result
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

  // Public top-level work commands are capabilities.
  if (hasCapabilityAction(cmd)) {
    result.command = "__capability__"
    result.actionName = cmd
    result.cliArgs = parseGenericFlags(argv.slice(1))
    if (typeof result.cliArgs.cwd === "string") result.cwd = result.cliArgs.cwd
    if (result.cliArgs.verbose === true) result.verbose = true
    if (result.cliArgs.quiet === true) result.quiet = true
    return result
  }

  const discoveredActions = listCapabilityActions().map((e) => e.action)
  const available = ["ci", "chat", "stats", "exec", "help", "version", ...discoveredActions]
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
  // - init runs BEFORE kody.config.json exists.
  const configlessCommands = new Set(["init"])

  if (args.command === "__capability__") {
    const route = resolveCapabilityAction(args.actionName!)
    if (!route) {
      process.stderr.write(`error: unknown capability action '${args.actionName}'\n`)
      return 64
    }
    const cliArgs = { ...route.cliArgs, ...(args.cliArgs ?? {}) }
    const skipConfig = configlessCommands.has(route.implementation)
    try {
      const result = await runJob(
        {
          action: route.action,
          capability: route.capability,
          implementation: route.implementation,
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

  if (args.command === "__exec__") {
    const executable = args.executableName!
    const cliArgs = args.cliArgs ?? {}
    const skipConfig = configlessCommands.has(executable)
    try {
      const result = await runJob(
        {
          action: executable,
          capability: executable,
          implementation: executable,
          executable,
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
      process.stderr.write(`[kody] ${executable} crashed: ${msg}\n`)
      if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
      process.stdout.write(`PR_URL=FAILED: ${executable} crashed: ${msg}\n`)
      return 99
    }
  }

  process.stderr.write("error: command did not resolve to a capability or executable\n")
  return 64
}

function numericTarget(cliArgs: Record<string, unknown>): number | undefined {
  for (const key of ["issue", "pr"]) {
    const raw = cliArgs[key]
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : Number.NaN
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}
