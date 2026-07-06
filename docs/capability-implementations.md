# Capability Implementations

A **capability implementation** is the runnable engine profile behind a
capability.

The public model should talk about capabilities and capability calls. This file
only describes the internal profile shape that lets a capability run.

## Canonical Shape

Shared capabilities and implementations live in `kody-store`:

```text
.kody/capabilities/<slug>/
  profile.json
  capability.md
  prompt.md      # only when an agent runs
  *.sh           # optional mechanical helpers
```

Project-specific implementations use the same capability-folder path inside a
consumer repo. The engine package keeps only minimal built-ins for bootstrap and
compatibility.

Capability directories must not contain TypeScript. Shared TypeScript belongs in
`src/scripts/` and must be registered in `src/scripts/index.ts`.

## Profile Contract

Every implementation profile is defined by `profile.json`.

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Capability slug. Must match the capability directory. |
| `role` | yes | Runtime shape: `primitive`, `orchestrator`, `container`, `watch`, or `utility`. |
| `kind` | yes | Execution timing, usually `oneshot` or `scheduled`. |
| `describe` | yes | Short human-readable action summary. |
| `inputs` | yes | CLI input contract. Use flags; do not parse ad hoc strings in scripts. |
| `claudeCode` | yes | Agent configuration. Use `maxTurns: 0` and empty tool lists for no-agent implementations. |
| `cliTools` | yes | External tools required by shell or scripts. Empty array when none. |
| `inputArtifacts` | yes | Task artifacts this implementation consumes. Empty array when none. |
| `outputArtifacts` | yes | Task artifacts this implementation writes. Empty array when none. |
| `scripts.preflight` | yes | Ordered deterministic setup, validation, dispatch, or no-agent work. |
| `scripts.postflight` | yes | Ordered deterministic persistence, comments, reports, commits, or cleanup. |
| `prompt.md` | when agent runs | Agent instructions. Do not add a prompt when `maxTurns: 0`. |

## Public Action Boundary

Public commands come from capability folders. Internal helper profiles set
`internal: true` so they can be resolved and scheduled without appearing as
public actions.

Examples include schedulers, tickers, managed-goal runners, task-job fixtures,
and release helpers. Run them by in-process handoff or explicit CLI with the
capability slug.

## Script Composition

Preflight and postflight lists are arrays of script entries. Each entry is one
of these:

- A registered TypeScript script from `src/scripts/index.ts`, using
  `script: "<name>"`.
- A shell script colocated in the capability directory, using
  `shell: "<name>.sh"`.

`runWhen` is the only conditional primitive. It maps dotted context paths to
expected values:

```json
{
  "scripts": {
    "preflight": [
      { "script": "loadGoalState" },
      {
        "script": "advanceManagedGoal",
        "runWhen": { "data.goal.state": "active" }
      },
      { "script": "skipAgent" }
    ],
    "postflight": [{ "script": "commitGoalState" }]
  }
}
```

The engine runner stays generic. It loads the profile, validates inputs, runs
the declared scripts, optionally calls the agent, then runs post-call scripts.

## Goal-Related Implementations

`goal-manager` is the generic managed-goal loop. It reads a managed goal,
chooses the first missing destination evidence, dispatches the matching
capability route step, and records pending evidence. It is the only canonical
goal runner.

Implementations must not become mini goal managers. A profile may accept domain
inputs required for the concrete work, but it should not require the parent goal
id, route, stage, or destination outcome as part of its normal contract. The
parent that invoked the profile owns that context and attaches the result to the
active goal or loop.

Existing profiles that still accept `--goal` are compatibility cases. Do not use
that pattern for new capability implementations unless the goal runner cannot
yet attach neutral result output.

Implementation anchors:

- `src/goal/manager.ts`
- `src/scripts/advanceManagedGoal.ts`
- `src/scripts/saveManagedGoalState.ts`
- `tests/unit/goal/manager.test.ts`

## Creating A Capability Implementation

Use this checklist:

1. Reuse an existing capability implementation if it already performs the concrete action.
2. Put shared implementations in `kody-store` under `.kody/capabilities/<slug>/`.
3. Put project-specific implementations in the consumer repo under the same path.
4. Add `profile.json` with explicit inputs, tools, scripts, and agent config.
5. Add `prompt.md` only when an agent runs.
6. Add shell helpers only for local mechanical work.
7. Put reusable TypeScript in `src/scripts/` and register it in `src/scripts/index.ts`.
8. Wire public capabilities to the implementation through capability `profile.json`, or set `internal: true` for helper implementations.
9. Add focused tests when routing, scripts, or profile behavior changes.

## Do Not

- Do not encode why or when in an implementation profile; that belongs in a capability or goal.
- Do not encode the destination/outcome manager loop in an implementation profile; that belongs in a goal.
- Do not make parent goal id a required input for reusable implementation profiles.
- Do not branch shared scripts on implementation names.
- Do not change consumer workflow YAML for normal new capabilities.
- Do not read `.kody/secrets.enc` from capability shell scripts; use shared engine secret helpers.
