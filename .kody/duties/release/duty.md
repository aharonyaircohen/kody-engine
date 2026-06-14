# Release

## Job

Orchestrate the four-stage release: prepare, merge, publish, deploy. The duty declares the four executables as a plan; the engine's task-jobs mechanism runs them in order, routing outcomes through the in-process nextDispatch hand-off. No code lives in this duty beyond the plan and the safety rules.

## Inputs

- `gh issue list --label release --state open`
- `gh issue view <release-issue-number>`

## Output

Refresh `kody-state:.kody/reports/release.md` with a report that follows this findings shape:

```yaml
slug: release
generatedAt: <ISO 8601 timestamp>
findings:
- id: <release-utc-date>
```

## Allowed Commands

- Use only the minimum read/write tools needed to refresh `kody-state:.kody/reports/release.md`.

## Restrictions

- Never edit source files from this duty.
- Never write outside `kody-state:.kody/reports/release.md` unless the user changes the duty contract.
- Maximum one report refresh per tick.
