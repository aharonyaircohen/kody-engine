import type { Context, PreflightScript, Profile } from "../implementations/types.js"
import { loadQaContext } from "./loadQaContext.js"

const PLAYWRIGHT_SERVER = {
  name: "playwright",
  command: "npx",
  args: ["-y", "--package=@playwright/mcp@latest", "--", "playwright-mcp", "--headless"],
}

interface CapabilityRequirements {
  browser?: boolean
  qaCredentials?: boolean
}

function requirementsFrom(ctx: Context): CapabilityRequirements {
  const raw = ctx.data.capabilityRequirements
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as CapabilityRequirements) : {}
}

function configureBrowser(profile: Profile): void {
  if (!profile.claudeCode.tools.includes("mcp__playwright")) {
    profile.claudeCode.tools = [...profile.claudeCode.tools, "mcp__playwright"]
  }
  if (!profile.claudeCode.mcpServers.some(({ name }) => name === PLAYWRIGHT_SERVER.name)) {
    profile.claudeCode.mcpServers = [...profile.claudeCode.mcpServers, PLAYWRIGHT_SERVER]
  }
}

function appendPrompt(ctx: Context, section: string): void {
  const prompt = typeof ctx.data.prompt === "string" ? ctx.data.prompt.trim() : ""
  ctx.data.prompt = [prompt, section.trim()].filter(Boolean).join("\n\n")
}

export const prepareSimpleCapabilityRuntime: PreflightScript = async (ctx, profile) => {
  const requirements = requirementsFrom(ctx)
  if (!requirements.browser) return

  configureBrowser(profile)
  if (!requirements.qaCredentials) return

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
