import * as fs from "node:fs"
import * as path from "node:path"

interface ToolHookInput {
  tool_input?: unknown
}

export function createMissingParentWriteGuard(cwd: string): (input: ToolHookInput) => Promise<Record<string, unknown>> {
  return async (input) => {
    const toolInput = input.tool_input
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return {}
    const filePath = (toolInput as Record<string, unknown>).file_path
    if (typeof filePath !== "string" || filePath.length === 0) return {}

    const resolvedPath = path.resolve(cwd, filePath)
    if (fs.existsSync(path.dirname(resolvedPath))) return {}

    return {
      decision: "block",
      reason:
        `Cannot write ${resolvedPath}: its parent directory does not exist. ` +
        "Locate and edit the real repository source path first. If this task genuinely requires a new directory, create that directory explicitly before writing the file.",
    }
  }
}
