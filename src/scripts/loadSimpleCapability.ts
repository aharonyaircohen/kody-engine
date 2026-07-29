import * as fs from "node:fs"
import * as path from "node:path"
import { validateCapabilityContractValue } from "../agency/capability-contract-validation.js"
import { readCapabilityFolder } from "../capabilityFolders.js"
import { capabilitiesRoot } from "../definition-paths.js"
import type { PreflightScript } from "../implementations/types.js"
import { capabilityConfigEnvironment, capabilityInputEnvironment } from "./capabilityExecutionEnvironment.js"

export const loadSimpleCapability: PreflightScript = async (ctx, profile) => {
  const slug = typeof ctx.args.capability === "string" ? ctx.args.capability.trim() : ""
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    throw new Error("capability-run requires a valid capability slug")
  }
  const capability = readCapabilityFolder(capabilitiesRoot(ctx.cwd), slug)
  if (!capability) {
    throw new Error(`Capability "${slug}" is not a valid simple capability folder`)
  }
  const toolRoot = path.join(capability.dir, "tools")
  const skillRoot = path.join(capability.dir, "skills")
  const toolFiles = listFiles(toolRoot)
  const skillFiles = listFiles(skillRoot)
  const parsedInput = parseInput(ctx.args.input)
  const input =
    parsedInput === undefined && capability.config.inputSchema?.type === "object"
      ? {}
      : parsedInput
  if (capability.config.inputSchema) {
    validateCapabilityContractValue("input", capability.config.inputSchema, input)
  }
  ctx.data.jobCapability = slug
  ctx.data.capabilityInput = input
  ctx.data.capabilityExecution = capability.contract?.execution ?? "agent"
  if (ctx.data.capabilityExecution === "agent") {
    registerCapabilitySubagents(profile, toolRoot, toolFiles)
  }
  if (capability.contract?.execution === "script") {
    ctx.data.capabilityScriptPath = path.join(capability.dir, "tools", "run.sh")
    ctx.data.capabilitySecretNames = capability.contract.secrets ?? []
    ctx.data.capabilityScriptTimeoutMs = capability.contract.timeoutMs
  }
  if (capability.config.outputSchema) {
    ctx.data.capabilityOutputSchema = capability.config.outputSchema
  }
  ctx.data.capabilityEnvironment = {
    ...capabilityInputEnvironment(input),
    ...capabilityConfigEnvironment(ctx.config),
  }
  ctx.data.prompt = [
    capability.rawBody.trim(),
    "",
    "## Input",
    "",
    "```json",
    JSON.stringify(input ?? null, null, 2),
    "```",
    "",
    ...(skillFiles.length
      ? [
          "",
          "## Skills",
          "",
          ...skillFiles.flatMap((file) => [
            `### ${file}`,
            "",
            fs.readFileSync(path.join(skillRoot, file), "utf-8"),
            "",
          ]),
        ]
      : []),
    ...(toolFiles.length
      ? [
          "",
          "## Tools",
          "",
          "Inspect or run these capability-owned files when needed:",
          ...toolFiles.map((file) => `- ${path.join(toolRoot, file)}`),
        ]
      : []),
    "",
    ...(capability.config.outputSchema
      ? [
          "## Output contract",
          "",
          "Produce one JSON result matching this schema:",
          "",
          "```json",
          JSON.stringify(capability.config.outputSchema, null, 2),
          "```",
        ]
      : ["Return one JSON value."]),
  ].join("\n")
}

function registerCapabilitySubagents(
  profile: Parameters<PreflightScript>[1],
  toolRoot: string,
  toolFiles: string[],
): void {
  const subagentFiles = toolFiles.flatMap((file) => {
    const match = /^agents\/([a-z][a-z0-9-]{0,63})\.md$/.exec(file)
    return match ? [{ name: match[1]!, file }] : []
  })
  if (subagentFiles.length === 0) return

  profile.claudeCode.subagents = [
    ...new Set([...profile.claudeCode.subagents, ...subagentFiles.map(({ name }) => name)]),
  ]
  profile.subagentTemplates = {
    ...(profile.subagentTemplates ?? {}),
    ...Object.fromEntries(
      subagentFiles.map(({ name, file }) => [name, fs.readFileSync(path.join(toolRoot, file), "utf-8")]),
    ),
  }
  if (!profile.claudeCode.tools.includes("Agent")) {
    profile.claudeCode.tools = [...profile.claudeCode.tools, "Agent"]
  }
}

function parseInput(supplied: unknown): unknown {
  if (typeof supplied !== "string") return supplied
  try {
    return JSON.parse(supplied)
  } catch {
    return parseFlagInput(supplied) ?? supplied
  }
}

function parseFlagInput(value: string): Record<string, unknown> | null {
  const tokens = value.trim().split(/\s+/).filter(Boolean)
  if (!tokens.some((token) => token.startsWith("--"))) return null
  const input: Record<string, unknown> = {}
  const text: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (!token.startsWith("--") || token.length === 2) {
      text.push(token)
      continue
    }
    const equalAt = token.indexOf("=")
    const name = equalAt >= 0 ? token.slice(2, equalAt) : token.slice(2)
    const next = equalAt >= 0 ? token.slice(equalAt + 1) : tokens[index + 1]
    if (equalAt < 0 && next && !next.startsWith("--")) index += 1
    input[name] = next && !next.startsWith("--") ? scalar(next) : true
  }
  if (text.length > 0) input.request = text.join(" ")
  return input
}

function scalar(value: string): string | number | boolean {
  if (value === "true" || value === "false") return value === "true"
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const files: string[] = []
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) files.push(path.relative(root, absolute))
    }
  }
  visit(root)
  return files.sort()
}
