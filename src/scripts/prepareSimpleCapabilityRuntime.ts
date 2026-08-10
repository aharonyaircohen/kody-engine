import { isIP } from "node:net"
import * as path from "node:path"
import type { Context, PreflightScript, Profile } from "../implementations/types.js"
import { loadQaContext } from "./loadQaContext.js"
import { resolveRuntimeSecret } from "./runtimeSecrets.js"

const PLAYWRIGHT_SERVER = {
  name: "playwright",
  command: "npx",
  args: ["-y", "--package=@playwright/mcp@latest", "--", "playwright-mcp", "--headless"],
}

interface CapabilityRequirements {
  browser?: boolean
  qaCredentials?: boolean
  githubTestToken?: boolean
  browserOnly?: boolean
}

function requirementsFrom(ctx: Context): CapabilityRequirements {
  const raw = ctx.data.capabilityRequirements
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as CapabilityRequirements) : {}
}

function isPrivateTargetHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number)
    return (
      a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    )
  }
  if (isIP(host) === 6) {
    return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8")
  }
  return false
}

function browserRuntime(ctx: Context, requirements: CapabilityRequirements) {
  if (!requirements.browserOnly) return PLAYWRIGHT_SERVER
  const input = ctx.data.capabilityInput
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Restricted browser capability requires object input")
  }
  const targetUrl = (input as Record<string, unknown>).targetUrl
  const qualityRunId = (input as Record<string, unknown>).qualityRunId
  let origin = ""
  try {
    const parsed = new URL(typeof targetUrl === "string" ? targetUrl : "")
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password && !isPrivateTargetHost(parsed.hostname)) {
      origin = parsed.origin
    }
  } catch {}
  if (!origin) throw new Error("Restricted browser capability requires a public HTTPS targetUrl")
  if (typeof qualityRunId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(qualityRunId)) {
    throw new Error("Restricted browser capability requires a valid qualityRunId")
  }
  return {
    ...PLAYWRIGHT_SERVER,
    args: [
      ...PLAYWRIGHT_SERVER.args,
      "--allowed-origins",
      origin,
      "--output-dir",
      path.resolve(ctx.cwd, "test-results", "quality-runs", qualityRunId),
    ],
  }
}

function configureBrowser(ctx: Context, profile: Profile, requirements: CapabilityRequirements): void {
  const server = browserRuntime(ctx, requirements)
  if (requirements.browserOnly) {
    profile.claudeCode.tools = ["Write"]
    profile.claudeCode.maxTurns = Math.min(profile.claudeCode.maxTurns ?? 50, 50)
  }
  if (!profile.claudeCode.tools.includes("mcp__playwright")) {
    profile.claudeCode.tools = [...profile.claudeCode.tools, "mcp__playwright"]
  }
  if (!profile.claudeCode.mcpServers.some(({ name }) => name === PLAYWRIGHT_SERVER.name)) {
    profile.claudeCode.mcpServers = [...profile.claudeCode.mcpServers, server]
  }
}

function appendPrompt(ctx: Context, section: string): void {
  const prompt = typeof ctx.data.prompt === "string" ? ctx.data.prompt.trim() : ""
  ctx.data.prompt = [prompt, section.trim()].filter(Boolean).join("\n\n")
}

export const prepareSimpleCapabilityRuntime: PreflightScript = async (ctx, profile) => {
  const requirements = requirementsFrom(ctx)
  if (!requirements.browser) return

  configureBrowser(ctx, profile, requirements)
  if (requirements.qaCredentials) {
    await loadQaContext(ctx, profile)
    appendPrompt(
      ctx,
      [
        "## QA authentication",
        "",
        String(ctx.data.qaAuthBlock ?? ""),
        "",
        "If the changed surface requires authentication and the credentials are missing or the login is rejected, " +
          "return a blocked result with a safe explanation. Do not include usernames, passwords, tokens, or other credential values in the result.",
      ].join("\n"),
    )
  }

  if (requirements.githubTestToken) {
    const token = await resolveRuntimeSecret("E2E_GITHUB_TOKEN", ctx)
    appendPrompt(
      ctx,
      token.value
        ? [
            "## Protected GitHub test login",
            "",
            `A protected GitHub test token is available: \`${token.value}\``,
            "Use it only if the target application asks for a GitHub personal access token; never include the token in screenshots, output, logs, files, or messages.",
          ].join("\n")
        : [
            "## Protected GitHub test login",
            "",
            "E2E_GITHUB_TOKEN is not configured. If this Quality Scenario requires GitHub token authentication, return a blocked result.",
          ].join("\n"),
    )
  }
}
