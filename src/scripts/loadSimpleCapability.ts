import * as fs from "node:fs"
import * as path from "node:path"
import { validateCapabilityContractValue } from "../agency/capability-contract-validation.js"
import { readCapabilityFolder } from "../capabilityFolders.js"
import { capabilitiesRoot } from "../definition-paths.js"
import type { PreflightScript } from "../implementations/types.js"

export const loadSimpleCapability: PreflightScript = async (ctx) => {
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
  const input = parseInput(ctx.args.input)
  if (capability.config.inputSchema) {
    validateCapabilityContractValue("input", capability.config.inputSchema, input)
  }
  ctx.data.jobCapability = slug
  ctx.data.capabilityInput = input
  ctx.data.capabilityExecution = capability.contract?.execution ?? "agent"
  if (capability.contract?.execution === "script") {
    ctx.data.capabilityScriptPath = path.join(capability.dir, "tools", "run.sh")
  }
  if (capability.config.outputSchema) {
    ctx.data.capabilityOutputSchema = capability.config.outputSchema
  }
  ctx.data.capabilityEnvironment = capabilityEnvironment(input)
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

function capabilityEnvironment(input: unknown): Record<string, string> {
  const environment: Record<string, string> = {
    KODY_CAPABILITY_INPUT: JSON.stringify(input ?? null),
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return environment
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    const key = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
    environment[`KODY_ARG_${key}`] = typeof value === "string" ? value : JSON.stringify(value)
  }
  return environment
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
