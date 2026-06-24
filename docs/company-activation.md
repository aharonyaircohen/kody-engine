# Company Activation

The company store is a catalog. Consumer repos decide which shared agentResponsibilities and goals are active in `kody.config.json`.

```json
{
  "company": {
    "activeAgentResponsibilities": ["release"],
    "activeGoals": ["web-release"]
  }
}
```

## AgentResponsibilities

Store agentResponsibilities are inactive by default. A store agentResponsibility may declare `every`, `agent`, or `agentAction`, but those fields are only used after the consumer lists the agentResponsibility under `company.activeAgentResponsibilities`.

Missing or empty `company.activeAgentResponsibilities` means no store agentResponsibilities auto-run. Local repo agentResponsibilities remain repo-owned.

## Goals

Store goals are inactive templates. Consumer repos may also define local goal templates.

```text
.kody/goals/templates/<slug>/state.json
<statePath>/goals/instances/<id>/state.json
```

String activation keeps the old behavior: it activates existing instances by id or by template.

```json
{ "company": { "activeGoals": ["web-release"] } }
```

Scheduled activation creates a fresh instance from the template for each time bucket, persists it to `stateRepo`, then ticks that instance.

```json
{
  "company": {
    "activeGoals": [
      { "template": "web-release", "every": "1w", "facts": { "issue": 123 } }
    ]
  }
}
```

Supported intervals are `Nm`, `Nh`, `Nd`, and `Nw`, such as `15m`, `2h`, `1d`, or `1w`.

## Rule

```text
kody-store = menu
consumer repo = decides what is enabled
activation = permission to run
scheduled goal = template creates a new runtime instance per bucket
```
