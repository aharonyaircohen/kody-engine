import Ajv, { type ErrorObject } from "ajv"

const validator = new Ajv({
  allErrors: true,
  strict: true,
  validateFormats: false,
})

export class CapabilityContractValidationError extends Error {
  constructor(
    readonly boundary: "input" | "output",
    readonly errors: readonly ErrorObject[],
  ) {
    const details = errors
      .map((error) => {
        const location = error.instancePath || "$"
        const property =
          error.keyword === "additionalProperties" &&
          typeof error.params.additionalProperty === "string"
            ? ` (${error.params.additionalProperty})`
            : ""
        return `${location}: ${error.message ?? error.keyword}${property}`
      })
      .join("; ")
    super(
      `Capability ${boundary} does not match its declared contract: ${details}`,
    )
    this.name = "CapabilityContractValidationError"
  }
}

export function validateCapabilityContractValue(
  boundary: "input" | "output",
  schema: Record<string, unknown>,
  value: unknown,
): void {
  const validate = validator.compile(schema)
  if (!validate(value)) {
    throw new CapabilityContractValidationError(boundary, validate.errors ?? [])
  }
}

export function capabilityContractInput(
  inputs: readonly { name: string }[],
  args: Record<string, unknown>,
): unknown {
  const isGenericRunnerInput =
    inputs.some((input) => input.name === "input") &&
    Object.hasOwn(args, "input")
  if (!isGenericRunnerInput) {
    const isParameterlessGenericRunner =
      inputs.some((input) => input.name === "capability") &&
      Object.hasOwn(args, "capability")
    return isParameterlessGenericRunner ? {} : args
  }

  const value = args.input
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
