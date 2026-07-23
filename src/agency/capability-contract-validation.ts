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
      `Capability ${boundary} does not match its canonical contract: ${validator.errorsText([...errors], {
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
