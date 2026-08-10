import * as fs from "node:fs"
import * as path from "node:path"
import { validateCapabilityContractValue } from "./agency/capability-contract-validation.js"

export interface OutputContract {
  path: string
  schema: Record<string, unknown>
}

interface ToolHookInput {
  tool_input?: unknown
}

function outputContractError(contract: OutputContract): string | null {
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(contract.path, "utf8"))
  } catch (error) {
    return `The required output file is missing or is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
  }

  try {
    validateCapabilityContractValue("output", contract.schema, value)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function correctionMessage(contract: OutputContract, error: string): string {
  return `The authoritative output does not match its required contract: ${error}. Please overwrite ${contract.path} with only the required JSON shape before finishing.`
}

export function createOutputContractPostWriteHook(
  contract: OutputContract,
): (input: ToolHookInput) => Promise<Record<string, unknown>> {
  const expectedPath = path.resolve(contract.path)
  return async (input) => {
    const toolInput = input.tool_input
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return {}
    const filePath = (toolInput as Record<string, unknown>).file_path
    if (typeof filePath !== "string" || path.resolve(filePath) !== expectedPath) return {}

    const error = outputContractError(contract)
    if (!error) return {}
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: correctionMessage(contract, error),
      },
    }
  }
}

export function createOutputContractStopHook(
  contract: OutputContract,
): () => Promise<Record<string, unknown>> {
  return async () => {
    if (!fs.existsSync(contract.path)) {
      return {
        decision: "block",
        reason:
          "Continue the Journey from the current page and complete the next unresolved user outcome. Do not write the result merely because you paused; write it only after the Journey passes, fails, or cannot safely continue.",
      }
    }

    const error = outputContractError(contract)
    if (!error) return {}
    return {
      decision: "block",
      reason: correctionMessage(contract, error),
    }
  }
}
