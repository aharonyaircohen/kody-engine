const SAFE_NAME = /^[a-z][a-z0-9-]*$/
const SAFE_STEP_ID = /^[A-Za-z][A-Za-z0-9_-]*$/
const SAFE_DATA_PATH = /^(facts|evidence|artifacts|result|workflow|lastOutcome)(?:\.[A-Za-z_][A-Za-z0-9_-]*)+$/

export interface WorkflowValidationIssue {
  code: string
  path: string
  message: string
}

export interface WorkflowValidationOptions {
  maxSteps?: number
  maxTransitionsPerStep?: number
  maxLoopIterations?: number
  knownCapabilities?: ReadonlySet<string>
  capabilityInputs?: ReadonlyMap<string, ReadonlySet<string>>
}

type Raw = Record<string, unknown>

const SUPPORTED_STEP_FIELDS = new Set([
  "id",
  "capability",
  "action",
  "implementation",
  "evidence",
  "target",
  "targetFact",
  "reason",
  "agent",
  "cliArgs",
  "inputs",
  "next",
  "runWhen",
  "continueOn",
  "saveReport",
  "report",
])
const SUPPORTED_TRANSITION_FIELDS = new Set(["to", "when", "default", "maxIterations"])

export function validateWorkflow(value: unknown, options: WorkflowValidationOptions = {}): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = []
  const workflow = asRecord(value)
  const rawSteps = Array.isArray(value) ? value : Array.isArray(workflow?.steps) ? workflow.steps : []
  const maxSteps = options.maxSteps ?? 100
  const maxTransitions = options.maxTransitionsPerStep ?? 20
  const maxLoopIterations = options.maxLoopIterations ?? 100

  if (rawSteps.length === 0) {
    issue(issues, "steps_required", "steps", "workflow must contain at least one step")
    return issues
  }
  if (rawSteps.length > maxSteps) {
    issue(issues, "too_many_steps", "steps", `workflow has ${rawSteps.length} steps; maximum is ${maxSteps}`)
  }

  const graphMode =
    workflow?.startAt !== undefined ||
    rawSteps.some((entry) => {
      const step = asRecord(entry)
      return Boolean(step && (step.id !== undefined || step.next !== undefined || step.inputs !== undefined))
    })
  const steps: Array<Raw | null> = rawSteps.map((entry) =>
    typeof entry === "string" ? { capability: entry } : asRecord(entry),
  )
  const ids: string[] = []

  steps.forEach((step, index) => {
    const base = `steps[${index}]`
    if (!step) {
      issue(issues, "invalid_step", base, "workflow step must be a capability name or an object")
      return
    }
    for (const field of Object.keys(step)) {
      if (!SUPPORTED_STEP_FIELDS.has(field)) {
        issue(issues, "unsupported_step_field", `${base}.${field}`, `workflow step field ${field} is not supported`)
      }
    }
    const capability = text(step.capability ?? step.action)
    if (!capability || !SAFE_NAME.test(capability)) {
      issue(issues, "invalid_capability", `${base}.capability`, "workflow step must name a valid capability")
    } else if (options.knownCapabilities && !options.knownCapabilities.has(capability)) {
      issue(
        issues,
        "unknown_capability",
        `${base}.capability`,
        `workflow step references unknown capability ${capability}`,
      )
    }

    if (graphMode) {
      const id = text(step.id)
      if (!id || !SAFE_STEP_ID.test(id)) {
        issue(issues, "invalid_step_id", `${base}.id`, "graph workflow steps must each have a valid id")
      } else {
        ids.push(id)
      }
    }

    validateDataMatch(step.runWhen, `${base}.runWhen`, issues)
    const inputs = asRecord(step.inputs)
    if (step.inputs !== undefined && !inputs) {
      issue(issues, "invalid_inputs", `${base}.inputs`, "workflow step inputs must be an object")
    }
    if (inputs) {
      for (const [name, mapping] of Object.entries(inputs)) {
        const inputPath = `${base}.inputs.${name}`
        if (!SAFE_NAME.test(name)) issue(issues, "invalid_input_name", inputPath, `invalid input name ${name}`)
        const from = text(asRecord(mapping)?.from)
        if (!from || !SAFE_DATA_PATH.test(from)) {
          issue(
            issues,
            "invalid_data_path",
            `${inputPath}.from`,
            `workflow input ${name} must read from facts, evidence, artifacts, result, workflow, or lastOutcome`,
          )
        }
        const declared = capability ? options.capabilityInputs?.get(capability) : undefined
        if (declared && !declared.has(name)) {
          issue(
            issues,
            "unknown_capability_input",
            inputPath,
            `capability ${capability} does not declare input ${name}`,
          )
        }
      }
    }
  })

  if (!graphMode) return issues

  const seen = new Set<string>()
  ids.forEach((id, index) => {
    if (seen.has(id)) issue(issues, "duplicate_step_id", `steps[${index}].id`, `workflow step id ${id} is duplicated`)
    seen.add(id)
  })
  const startAt = text(workflow?.startAt) ?? text(steps[0]?.id)
  if (!startAt || !seen.has(startAt)) {
    issue(issues, "missing_start_step", "startAt", `workflow startAt references missing step ${startAt ?? "<none>"}`)
  }

  const adjacency = new Map<string, string[]>()
  steps.forEach((step, index) => {
    if (!step) return
    const id = text(step.id)
    if (!id) return
    const transitions = transitionList(step.next)
    adjacency.set(id, [])
    if (transitions.length > maxTransitions) {
      issue(
        issues,
        "too_many_transitions",
        `steps[${index}].next`,
        `workflow step ${id} has ${transitions.length} connections; maximum is ${maxTransitions}`,
      )
    }
    const defaults = transitions.filter((transition) => asRecord(transition)?.default === true)
    const conditionals = transitions.filter((transition) => asRecord(transition)?.when !== undefined)
    const unconditional = transitions.filter((transition) => {
      const raw = asRecord(transition)
      return (
        typeof transition === "string" ||
        Boolean(raw && raw.when === undefined && raw.default !== true && raw.maxIterations === undefined)
      )
    })
    if (defaults.length > 1) {
      issue(
        issues,
        "multiple_default_transitions",
        `steps[${index}].next`,
        `workflow step ${id} has more than one default connection`,
      )
    }
    if (conditionals.length > 0 && defaults.length !== 1) {
      issue(
        issues,
        "missing_default_transition",
        `steps[${index}].next`,
        `workflow step ${id} has conditions and needs one default connection`,
      )
    }
    if (unconditional.length > 1 || (unconditional.length > 0 && transitions.length > 1)) {
      issue(
        issues,
        "ambiguous_transition",
        `steps[${index}].next`,
        `workflow step ${id} mixes an unconditional connection with other connections`,
      )
    }

    transitions.forEach((transition, transitionIndex) => {
      const raw = typeof transition === "string" ? { to: transition } : asRecord(transition)
      const base = `steps[${index}].next[${transitionIndex}]`
      if (!raw) {
        issue(issues, "invalid_transition", base, "workflow connection must be a step id or an object")
        return
      }
      for (const field of Object.keys(raw)) {
        if (!SUPPORTED_TRANSITION_FIELDS.has(field)) {
          issue(
            issues,
            "unsupported_transition_field",
            `${base}.${field}`,
            `workflow connection field ${field} is not supported`,
          )
        }
      }
      const target = text(raw.to)
      if (!target || !SAFE_NAME.test(target)) {
        issue(issues, "invalid_transition_target", `${base}.to`, "workflow connection must name a valid target step")
        return
      }
      if (!seen.has(target)) {
        issue(
          issues,
          "missing_transition_target",
          `${base}.to`,
          `workflow step ${id} connects to missing step ${target}`,
        )
      } else {
        adjacency.get(id)?.push(target)
      }
      if (raw.default === true && raw.when !== undefined) {
        issue(issues, "conflicting_transition", base, "workflow connection cannot be both conditional and default")
      }
      if (raw.when !== undefined) validateDataMatch(raw.when, `${base}.when`, issues)
      const targetIndex = ids.indexOf(target ?? "")
      const iterations = raw.maxIterations
      if (targetIndex >= 0 && targetIndex <= index) {
        if (!Number.isInteger(iterations) || Number(iterations) < 1) {
          issue(
            issues,
            "unbounded_loop",
            `${base}.maxIterations`,
            `workflow loop ${id}->${target} must set maxIterations`,
          )
        } else if (Number(iterations) > maxLoopIterations) {
          issue(
            issues,
            "loop_limit_too_high",
            `${base}.maxIterations`,
            `workflow loop ${id}->${target} exceeds maximum ${maxLoopIterations}`,
          )
        }
      } else if (iterations !== undefined && (!Number.isInteger(iterations) || Number(iterations) < 1)) {
        issue(issues, "invalid_loop_limit", `${base}.maxIterations`, "maxIterations must be a positive integer")
      }
    })
  })

  if (startAt && seen.has(startAt)) {
    const reachable = new Set<string>()
    const pending = [startAt]
    while (pending.length > 0) {
      const id = pending.pop()!
      if (reachable.has(id)) continue
      reachable.add(id)
      pending.push(...(adjacency.get(id) ?? []))
    }
    ids.forEach((id, index) => {
      if (!reachable.has(id)) issue(issues, "unreachable_step", `steps[${index}]`, `workflow step ${id} is unreachable`)
    })
    if (![...reachable].some((id) => (adjacency.get(id) ?? []).length === 0)) {
      issue(issues, "missing_terminal_step", "steps", "workflow has no reachable final step")
    }
  }

  return issues
}

export function formatWorkflowValidationIssues(issues: readonly WorkflowValidationIssue[]): string[] {
  return issues.map((entry) => `${entry.path}: ${entry.message}`)
}

function validateDataMatch(value: unknown, path: string, issues: WorkflowValidationIssue[]): void {
  if (value === undefined) return
  const match = asRecord(value)
  if (!match || Object.keys(match).length === 0) {
    issue(issues, "invalid_condition", path, "workflow condition must contain at least one match")
    return
  }
  for (const [field, expected] of Object.entries(match)) {
    if (!SAFE_DATA_PATH.test(field)) {
      issue(
        issues,
        "invalid_data_path",
        `${path}.${field}`,
        `workflow condition must read from facts, evidence, artifacts, result, workflow, or lastOutcome`,
      )
    }
    if (!isComparable(expected)) {
      issue(issues, "invalid_condition_value", `${path}.${field}`, "workflow condition value must be a JSON scalar")
    }
  }
}

function transitionList(value: unknown): unknown[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function asRecord(value: unknown): Raw | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function isComparable(value: unknown): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true
  return Array.isArray(value) && value.length > 0 && value.every((item) => isComparable(item) && !Array.isArray(item))
}

function issue(issues: WorkflowValidationIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message })
}
