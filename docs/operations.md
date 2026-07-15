# Operations

An Operation is one durable agency **responsibility boundary** justified by active company Intents.

## Ownership

An Operation owns:

- one stable responsibility;
- explicit `doesNotOwn` boundaries;
- the active `intentIds` that justify it;
- accountable Goal and Loop references;
- lifecycle state.

It does not own company direction, shared Capabilities, Workflows, Agents, capability implementation, or runtime progress. Goals and Loops remain separate models; the Operation is accountable for them but does not contain their definitions.

## Storage

Operation contracts live in the configured state repo at:

`<statePath>/operations/<id>/operation.json`

The canonical version-1 fields are `version`, `id`, `name`, `responsibility`, `doesNotOwn`, `intentIds`, `goals`, `loops`, `status`, `createdAt`, and `updatedAt`. A proposed Operation may have empty `goals` and `loops` while its required models are provisioned.

Lifecycle is `proposed` -> `provisioning` -> `active`. A creator always emits `proposed`. Human approval is required before provisioning, and activation requires active linked Intents, at least one accountable Goal or Loop, and valid references.

## Creation rule

Portfolio management decides whether a responsibility is genuinely missing. `operation-creator` authors and validates exactly one proposed contract. Portfolio management must not bypass that review boundary by writing the contract itself.
