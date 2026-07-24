import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../implementations/types.js"
import { capabilitiesRoot } from "../definition-paths.js"
import { readCapabilityFolder } from "../capabilityFolders.js"

export const loadSimpleCapability: PreflightScript = async (ctx) => {
  const slug = typeof ctx.args.capability === "string" ? ctx.args.capability.trim() : ""
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    throw new Error("capability-run requires a valid capability slug")
  }
  const capability = readCapabilityFolder(capabilitiesRoot(ctx.cwd), slug)
  if (!capability) {
    throw new Error(`Capability "${slug}" is not a valid simple capability folder`)
  }
  const contract = capability.rawProfile.contract as {
    input: { name: string; schema: Record<string, unknown> }
    output: { name: string; schema: Record<string, unknown> }
  }
  const toolRoot = path.join(capability.dir, "tools")
  const skillRoot = path.join(capability.dir, "skills")
  const toolFiles = listFiles(toolRoot)
  const skillFiles = listFiles(skillRoot)
  const supplied = ctx.args.input
  let input: unknown = supplied
  if (typeof supplied === "string") {
    try {
      input = JSON.parse(supplied)
    } catch {
      input = supplied
    }
  }
  ctx.data.jobCapability = slug
  ctx.data.capabilityInput = input
  ctx.data.capabilityContract = contract
  ctx.data.prompt = [
    capability.rawBody.trim(),
    "",
    "## Input",
    "",
    "```json",
    JSON.stringify({ [contract.input.name]: input }, null, 2),
    "```",
    "",
    "Return one JSON value matching the output contract:",
    "",
    "```json",
    JSON.stringify({ [contract.output.name]: contract.output.schema }, null, 2),
    "```",
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
  ].join("\n")
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
