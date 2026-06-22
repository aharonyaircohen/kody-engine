# State-reducer pattern for agentActions

Status: proposed

## The idea

Model each agentAction as a **pure function**, the task (issue/PR) as a **store**, and the agentAction's output as a **typed action**. Any future orchestrator reads the store, dispatches an agentAction, and applies the returned state change. No free-text parsing, no implicit state reconstruction.

## The three concepts

### 1. AgentAction = pure function

Each agentAction declares an explicit contract:

```
agentAction :: (stateSlice, args) -> (newStateSlice, action)
```

- **Input schema**: which parts of the task state it reads + which CLI args it accepts.
- **Output schema**: the typed action it emits.
- **No hidden side-state.** Anything that survives the run is either committed to the task state or visible as git/PR changes.

Schemas live in `profile.json` alongside the existing `inputs` block.

### 2. Task = store

The GitHub issue or PR is the canonical state location. A single structured comment on the task holds the state, owned and rewritten by kody:

```
<!-- kody:state:begin -->
```json
{
  "schemaVersion": 1,
  "core": {
    "phase": "implementing",
    "status": "running",
    "currentAgentAction": "build",
    "lastOutcome": null,
    "attempts": { "build": 1 },
    "prUrl": "https://github.com/…/pull/456"
  },
  "agentActions": {
    "build":  { "lastAction": { "type": "BUILD_COMPLETED",  "payload": { "commitSha": "abc123" } } },
    "review": { "lastAction": null }
  }
}
```
<!-- kody:state:end -->

History
- 2026-04-20T09:12Z  build  BUILD_COMPLETED  abc123
- 2026-04-20T09:08Z  build  BUILD_STARTED    —
```

Rules:
- One comment per task. Rewritten in place at the end of each run.
- Machine-readable block between sentinels, human-readable history below.
- Readers dispatch on the typed action — never parse the free-text markdown.

### 3. Reducer shape

Every run is a reducer application:

```
(state, { agentAction, args, action })  ->  newState
```

- `state` is read from the configured Kody state repo at run start.
- `agentAction` does its work, producing an action.
- The postflight that writes task state is the reducer: it merges the action into state.
- `newState` is written back to the state repo file; the previous entry is appended to the history section.

## State structure

```
state = {
  schemaVersion: number,
  core: {
    phase:             "research" | "planning" | "implementing" | "reviewing" | "shipped" | "failed",
    status:            "pending"  | "running" | "succeeded" | "failed",
    currentAgentAction: string | null,
    lastOutcome:       action | null,
    attempts:          Record<agentActionName, number>,
    prUrl?:            string,
  },
  agentActions: Record<agentActionName, {
    lastAction: action | null,
    // per-agentAction namespaced data ("build" may stash branch, "review" may stash verdict, etc.)
  }>,
}
```

- **core** is the predictable contract every reader depends on.
- **agentActions** is open-ended; each agentAction owns its own namespace.
- **History** is append-only below the JSON block; never edited.

## Action shape

```
action = {
  type:      string,          // e.g. "BUILD_COMPLETED", "REVIEW_CONCERNS", "FIX_APPLIED"
  payload:   object,          // type-specific fields
  timestamp: ISO8601,
}
```

Emitted by the agentAction, parsed by the reducer, written into `core.lastOutcome` + appended to history.

## Scope of this doc

This ADR covers **pattern only**:

- State store in a structured task comment
- Typed input/output schemas in profiles
- Append-only history

Out of scope (follow-up decisions):

- Orchestrator agentAction that chains multiple runs
- Multi-task coordination
- State-machine validation engine
- README-level announcement of the pattern

## Why

- **Determinism.** Orchestrators dispatch on `action.type`, not on free-text parsing.
- **Testability.** Each reducer is a pure function of its state slice.
- **Debuggability.** The history section is an audit log.
- **Composability.** Any orchestrator can drive any agentAction as long as schemas match.
- **Incremental cost.** Roughly the work of adding one store-read and one store-write helper plus one schema field per profile.
