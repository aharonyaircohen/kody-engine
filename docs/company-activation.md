# Company Activation

The company store is a catalog. Consumer repos decide which shared capabilities
and goals are active in `kody.config.json`.

```json
{
  "company": {
    "activeCapabilities": ["release"],
    "activeGoals": ["web-release"]
  }
}
```

## Capabilities

Store capabilities are inactive by default. A store capability may declare
`every`, `agent`, `action`, or implementation wiring, but those fields are only
used after the consumer lists the capability under `company.activeCapabilities`.

Missing or empty `company.activeCapabilities` means no store capabilities
auto-run. Local repo capabilities remain repo-owned.

`company.activeAgentResponsibilities` remains a legacy compatibility field while
older repos migrate. Do not use it for new activation.

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
