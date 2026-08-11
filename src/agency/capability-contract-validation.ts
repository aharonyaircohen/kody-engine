import Ajv, { type ErrorObject } from "ajv"

const validator = new Ajv({
  allErrors: true,
  strict: true,
  validateFormats: false,
})

type ContractValidator = ((value: unknown) => boolean) & {
  errors?: readonly ErrorObject[] | null
}

type ContractCompiler = (schema: Record<string, unknown>) => ContractValidator
type CapabilityContractValueValidator = (
  boundary: "input" | "output",
  schema: Record<string, unknown>,
  value: unknown,
) => void

export class CapabilityContractValidationError extends Error {
  constructor(
    readonly boundary: "input" | "output",
    readonly errors: readonly ErrorObject[],
  ) {
    const details = errors
      .map((error) => {
        const location = error.instancePath || "$"
        const property =
          error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string"
            ? ` (${error.params.additionalProperty})`
            : ""
        return `${location}: ${error.message ?? error.keyword}${property}`
      })
      .join("; ")
    super(`Capability ${boundary} does not match its declared contract: ${details}`)
    this.name = "CapabilityContractValidationError"
  }
}

export class CapabilityContractMissingOutputError extends Error {
  constructor() {
    super("Capability output is missing despite its declared contract")
    this.name = "CapabilityContractMissingOutputError"
  }
}

export function createCapabilityContractValueValidator(compile: ContractCompiler): CapabilityContractValueValidator {
  const compiled = new WeakMap<Record<string, unknown>, ContractValidator>()
  return (boundary, schema, value) => {
    let validate = compiled.get(schema)
    if (!validate) {
      validate = compile(schema)
      compiled.set(schema, validate)
    }
    if (!validate(value)) {
      throw new CapabilityContractValidationError(boundary, validate.errors ?? [])
    }
  }
}

export const validateCapabilityContractValue: CapabilityContractValueValidator = createCapabilityContractValueValidator(
  (schema) => validator.compile(schema),
)

export function validateCapabilityContractOutput(schema: Record<string, unknown>, value: unknown): void {
  if (value === undefined) throw new CapabilityContractMissingOutputError()
  validateCapabilityContractValue("output", schema, value)
}

export function capabilityContractInput(
  inputs: readonly { name: string }[],
  args: Record<string, unknown>,
  capabilityId?: string,
  contractProperties: readonly string[] = [],
): unknown {
  const isGenericRunnerInput = inputs.some((input) => input.name === "input") && Object.hasOwn(args, "input")
  if (!isGenericRunnerInput) {
    const isParameterlessGenericRunner =
      (inputs.some((input) => input.name === "capability") ||
        args.capability === capabilityId ||
        !contractProperties.includes("capability")) &&
      Object.hasOwn(args, "capability")
    if (!isParameterlessGenericRunner) return args
    const { capability: _routingCapability, ...businessArgs } = args
    return businessArgs
  }

  const value = args.input
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
