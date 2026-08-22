export interface AcceptanceCriterion {
  id: string
  text: string
}

const ACCEPTANCE_HEADING = /^(?:acceptance(?: criteria)?|requirements|expected behavior)$/i
const HEADING = /^#{1,6}\s+(.+?)\s*$/
const LIST_ITEM = /^\s*(?:[-*+] |\d+[.)] )(?:\[[ xX]\]\s*)?(.+?)\s*$/

/** Extract explicit markdown list items from the issue's acceptance section. */
export function extractAcceptanceCriteria(body: string): AcceptanceCriterion[] {
  const found: string[] = []
  let inAcceptance = false
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(HEADING)
    if (heading) {
      inAcceptance = ACCEPTANCE_HEADING.test(heading[1]!.replace(/:$/, "").trim())
      continue
    }
    if (!inAcceptance) continue
    const item = line.match(LIST_ITEM)?.[1]?.trim()
    if (item) found.push(item)
  }
  return found.map((text, index) => ({ id: `A${index + 1}`, text }))
}

export function formatAcceptanceCriteria(criteria: AcceptanceCriterion[]): string {
  if (criteria.length === 0) {
    return "No explicit acceptance list was detected. Derive the concrete promised outcomes and prove each one."
  }
  return criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}`).join("\n")
}
