# Executables

Executables are the company layer's **how**.

An executable is one concrete action the generic executor can run. It may be
mechanical and no-agent, or it may invoke an agent with a prompt, tools, hooks,
skills, and postflight checks.

An executable is not a duty and not a goal. Duties explain why or when work
should run. Goals choose which duty or evidence comes next. Executables perform
the action.

## Canonical Shape

Shared executables live in `kody-store`:

```text
.kody/executables/<slug>/
  profile.json
  prompt.md      # only when an agent runs
  *.sh           # optional mechanical helpers
```

Project-specific executables may live in the same path inside a consumer repo.
The engine package keeps only the minimal built-in `run` executable under
`src/executables/run`.

Executable directories must not contain TypeScript. Shared TypeScript belongs in
`src/scripts/` and must be registered in `src/scripts/index.ts`.

## Profile Contract

Every executable is defined by `profile.json`.

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Executable slug. Must match the executable directory. |
| `role` | yes | Semantic role: `primitive`, `orchestrator`, `container`, `watch`, or `utility`. |
| `kind` | yes | Execution timing, usually `oneshot` or `scheduled`. |
| `describe` | yes | Short human-readable action summary. |
| `inputs` | yes | CLI input contract. Use flags; do not parse ad hoc strings in scripts. |
| `claudeCode` | yes | Agent configuration. Use `maxTurns: 0` and empty tool lists for no-agent executables. |
| `cliTools` | yes | External tools required by shell or scripts. Empty array when none. |
| `inputArtifacts` | yes | Task artifacts this executable consumes. Empty array when none. |
| `outputArtifacts` | yes | Task artifacts this executable writes. Empty array when none. |
| `scripts.preflight` | yes | Ordered deterministic setup, validation, dispatch, or no-agent work. |
| `scripts.postflight` | yes | Ordered deterministic persistence, comments, reports, commits, or cleanup. |
| `prompt.md` | when agent runs | Agent instructions. Do not add a prompt when `maxTurns: 0`. |

## Script Composition

Preflight and postflight lists are arrays of script entries. Each entry is one
of these:

- A registered TypeScript script from `src/scripts/index.ts`, using
  `script: "<name>"`.
- A shell script colocated in the executable directory, using
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

The executor stays generic. It loads the profile, validates inputs, runs the
declared scripts, optionally calls the agent, then runs postflight scripts.

## Goal-Related Executables

`goal-manager` is the generic managed-goal loop. It reads a managed goal,
chooses the first missing destination evidence, dispatches the matching
duty/executable route step, and records pending evidence. It is not the old
stacked-task flow.

`goal-tick` is the legacy stacked-task bridge. Keep it only for old goal state
that has not been migrated yet.

Implementation anchors:

- `src/goal/manager.ts`
- `src/scripts/advanceManagedGoal.ts`
- `src/scripts/saveManagedGoalState.ts`
- `tests/unit/goal/manager.test.ts`

## Duty Report Contract

Duties and executables may report facts by emitting one stdout line:

```text
KODY_DUTY_REPORT={"target":{"type":"goal","id":"release-aguy"},"evidence":{"releasePrExists":true},"facts":{"releasePr":123}}
```

Rules:

- Reports are factual only.
- Reports do not set goal `stage`, `route`, `duties`, `destination`, `blockers`, or `state`.
- Goal evidence is stored under goal `facts`.
- Profiles that need report persistence should include `applyDutyReports` in postflight.
- Route args can read reported facts with `{ "fact": "<name>" }`.

## Creating An Executable

Use this checklist:

1. Reuse an existing executable if it already performs the concrete action.
2. Put shared executables in `kody-store` under `.kody/executables/<slug>/`.
3. Put project-specific executables in the consumer repo under the same path.
4. Add `profile.json` with explicit inputs, tools, scripts, and agent config.
5. Add `prompt.md` only when an agent runs.
6. Add shell helpers only for local mechanical work.
7. Put reusable TypeScript in `src/scripts/` and register it in `src/scripts/index.ts`.
8. Wire duties to the executable through duty `profile.json`.
9. Add focused tests when routing, scripts, or profile behavior changes.

## Do Not

- Do not encode why or when in an executable; that belongs in a duty.
- Do not encode the destination/outcome manager loop in an executable; that belongs in a goal.
- Do not branch shared scripts on executable names.
- Do not change consumer workflow YAML for normal new capabilities.
- Do not read `.kody/secrets.enc` from executable shell scripts; read injected environment variables.
