import {
  ENGINE_EXECUTION_REQUEST_ENV,
  parseEngineExecutionRequest,
  type EngineExecutionRequest,
  type EngineExecutionRequestParseResult,
} from "@kody-ade/engine-contracts"

export const RUN_REQUEST_ENV = ENGINE_EXECUTION_REQUEST_ENV
export type RunRequest = EngineExecutionRequest
export type RunRequestParseResult = EngineExecutionRequestParseResult
export { parseEngineExecutionRequest as parseRunRequest }

export function readRunRequestFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RunRequestParseResult | null {
  const raw = env[RUN_REQUEST_ENV]
  if (raw == null || raw.trim() === "") return null
  return parseEngineExecutionRequest(raw)
}
