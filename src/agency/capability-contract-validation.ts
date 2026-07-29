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
    super(
      `Capability ${boundary} does not match its declared contract: ${validator.errorsText([...errors], {
        separator: "; ",
      })}`,
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
  if (!isGenericRunnerInput) return args

  const value = args.input
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
