# Duties

Duties are the company layer's **why** and **when**.

A duty is a standing responsibility. It explains why work exists, who should own
it, when it should run, and which executable usually implements it. A duty may
serve many goals over time, but it is not a goal. A goal is a temporary outcome;
a duty is recurring ownership.

## Canonical Shape

Duties live in project `.kody/duties/` or in the company store:

```text
.kody/duties/<slug>/
  profile.json
  duty.md
```

`profile.json` is metadata and routing. `duty.md` is human-owned intent.

Example:

```json
{
  "name": "goal-manager",
  "action": "goal-manager",
  "executable": "goal-manager",
  "staff": "coo",
  "every": "manual",
  "describe": "Advance one managed goal by dispatching the duty responsible for the first missing evidence."
}
```

## Field Contract

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Duty slug. Must match the folder name. |
| `describe` | yes | Short responsibility summary. |
| `action` | optional | Public action name. If absent, defaults to the duty name. |
| `executable` | usually | Implementation executable, the how. |
| `executables` | optional | Ordered executable list for duties that split work into child jobs. |
| `staff` | optional | Staff persona, the who. |
| `every` | optional | Scheduler cadence. Use `manual` for on-demand duties. |
| `mentions` | optional | GitHub logins to mention in duty output. |
| `dutyTools` | optional | Locked duty MCP tool names. |
| `disabled` | optional | Prevents scheduled execution. |

`duty.md` should define:

- Purpose.
- Inputs the duty may inspect.
- Outputs the duty may write.
- Allowed commands and tools.
- Restrictions and escalation rules.

## How Duties Run

There are two common duty paths:

1. Manual or goal-routed duty.
2. Scheduled duty.

For manual or goal-routed duty:

- A user, goal, or executable dispatches the duty action.
- The duty profile selects staff and executable.
- The executor runs the selected executable.

For scheduled duty:

- `duty-scheduler` wakes due duty folders.
- It checks `every`, `disabled`, and duty state.
- It runs `duty-tick` or `duty-tick-scripted`.

The duty body is not executable code. Deterministic behavior belongs in
executables and scripts. The duty says why the responsibility exists.

## Creating A Duty

Use this checklist:

1. Pick a stable slug for the responsibility, not a one-time task.
2. Decide whether it belongs in the project or in shared `kody-store`.
3. Write `profile.json` with `name`, `describe`, and usually `executable`.
4. Add `staff` only when a specific persona matters.
5. Add `every` only when the duty is scheduled.
6. Write `duty.md` with purpose, inputs, outputs, allowed actions, and restrictions.
7. Reuse existing executables where possible.

## Do Not

- Do not create a new duty for a one-off issue comment.
- Do not put concrete implementation logic in `duty.md`.
- Do not let duties dispatch by bot-authored `@kody` comments; use workflow dispatch or in-process dispatch.
- Do not duplicate an existing store duty without a project-specific reason.
