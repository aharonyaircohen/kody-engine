# Capabilities and Implementation Profiles

A **Capability** is the company layer's public **how**. The new project/store
asset root is:

```text
.kody/capabilities/<slug>/
  profile.json
  capability.md
```

An implementation profile is the runnable engine profile behind a capability.
External implementation profiles live in capability folders. Project/store
`.kody/executables/<slug>/` folders are obsolete and are not resolver sources.

An implementation profile is one concrete action the generic executor can run. It may be
mechanical and no-agent, or it may invoke an agent with a prompt, tools, hooks,
skills, and postflight checks.

An implementation profile is not a goal. A capability folder may be public
(`action`, owner, cadence, output contract) or internal (`internal: true`) and
may also carry the runnable profile (`role`, scripts, prompt, skills). Goals
choose which capability or evidence comes next. Implementation profiles perform
the work.

## Canonical Shape

Shared capabilities and implementation profiles live in `kody-store`:

```text
.kody/capabilities/<slug>/
  profile.json
  capability.md
  prompt.md      # only when an agent runs
  *.sh           # optional mechanical helpers
```

Project-specific implementation profiles use the same capability-folder path
inside a consumer repo. The engine package keeps only minimal built-ins under
`src/executables/run`.

Capability directories must not contain TypeScript. Shared TypeScript belongs in
`src/scripts/` and must be registered in `src/scripts/index.ts`.

## Profile Contract

Every implementation profile is defined by `profile.json`.

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Capability slug. Must match the capability directory. |
| `role` | yes | Semantic role: `primitive`, `orchestrator`, `container`, `watch`, or `utility`. |
| `kind` | yes | Execution timing, usually `oneshot` or `scheduled`. |
| `describe` | yes | Short human-readable action summary. |
| `inputs` | yes | CLI input contract. Use flags; do not parse ad hoc strings in scripts. |
| `claudeCode` | yes | Agent configuration. Use `maxTurns: 0` and empty tool lists for no-agent implementations. |
| `cliTools` | yes | External tools required by shell or scripts. Empty array when none. |
| `inputArtifacts` | yes | Task artifacts this executable consumes. Empty array when none. |
| `outputArtifacts` | yes | Task artifacts this executable writes. Empty array when none. |
| `scripts.preflight` | yes | Ordered deterministic setup, validation, dispatch, or no-agent work. |
| `scripts.postflight` | yes | Ordered deterministic persistence, comments, reports, commits, or cleanup. |
| `prompt.md` | when agent runs | Agent instructions. Do not add a prompt when `maxTurns: 0`. |

## Public Action Boundary

Public commands come from capability folders. Internal helper profiles set
`internal: true` so they can be resolved and scheduled without appearing as
public actions.

Examples include schedulers, tickers, managed-goal runners, task-job fixtures,
and release helpers. Run them by in-process handoff or explicit CLI:

```bash
kody-engine exec <capability-slug>
```

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

The executor stays generic. It loads the profile, validates inputs, runs the
declared scripts, optionally calls the agent, then runs postflight scripts.

## Goal-Related Implementations

`goal-manager` is the generic managed-goal loop. It reads a managed goal,
chooses the first missing destination evidence, dispatches the matching
capability route step, and records pending evidence. It is the only
canonical goal runner.

Implementation anchors:

- `src/goal/manager.ts`
- `src/scripts/advanceManagedGoal.ts`
- `src/scripts/saveManagedGoalState.ts`
- `tests/unit/goal/manager.test.ts`

## Capability Result Contract

Capability implementations should return one machine-readable result when they finish:

```text
KODY_CAPABILITY_RESULT={"version":1,"target":{"type":"goal","id":"web-release"},"status":"pass","summary":"CI is green.","evidence":{"ciGreen":true},"facts":{"pr":123},"artifacts":[],"missingEvidence":[],"blockers":[]}
```

Rules:

- `target` names the goal or loop that should consume this evidence when known.
- `status` must be `pass`, `fail`, `blocked`, `changed`, or `noop`.
- `summary` is required and should be short.
- `evidence` is optional boolean proof for named goal/loop evidence.
- `facts` is machine data for the parent agentGoal or agentLoop.
- `artifacts` is optional links or paths.
- `missingEvidence` names expected evidence still not proven.
- `blockers` names concrete blockers the parent should recover from or stop on.
- A capability result says what happened. The parent model decides what it means.

## Capability Report Contract

Older capabilities and implementations may report facts by emitting one stdout line:

```text
KODY_CAPABILITY_REPORT={"target":{"type":"goal","id":"release-aguy"},"evidence":{"releasePrExists":true},"facts":{"releasePr":123}}
```

Rules:

- Reports are factual only.
- Reports do not set goal `stage`, `route`, `capabilities`, `destination`, `blockers`, or `state`.
- Goal evidence is stored under goal `facts`.
- New capabilities should prefer `KODY_CAPABILITY_RESULT` with `target` and `evidence`.
- Do not emit both marker types for the same evidence in new code. The engine merges both only for compatibility with existing actions.
- Profiles that emit capability evidence should include `applyCapabilityReports` in postflight.
- `saveReport` writes Dashboard markdown under `reports/<goal-or-loop>/runs/` from the goal/loop decision path, after state persistence succeeds.
- Route args can read reported facts with `{ "fact": "<name>" }`.

Capability output is how a reusable capability hands evidence back to a goal. It is
not a manager loop. An implementation may prove `releasePrExists`, `mainMerged`,
or `productionDeployed`; the goal decides whether those facts complete the
agentGoal and writes the goal log.

When a capability profile declares `capabilityKind`, implementation output should match
that promise:

| `capabilityKind` | Output should describe |
| --- | --- |
| `observe` | Facts, alerts, suggested actions, or evidence discovered. |
| `act` | Created/changed resources, triggered operations, action status, or evidence. |
| `verify` | Pass/fail result with evidence, blockers, and facts. |

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
- Do not branch shared scripts on implementation names.
- Do not change consumer workflow YAML for normal new capabilities.
- Do not read `.kody/secrets.enc` from capability shell scripts; read injected environment variables.
