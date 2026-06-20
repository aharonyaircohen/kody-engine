# Company Activation

The company store is a catalog. Consumer repos decide which shared duties and goals are active in `kody.config.json`.

```json
{
  "company": {
    "activeDuties": ["release"],
    "activeGoals": ["web-release"]
  }
}
```

## Duties

Store duties are inactive by default. A store duty may declare `every`, `staff`, or `executable`, but those fields are only used after the consumer lists the duty under `company.activeDuties`.

Missing or empty `company.activeDuties` means no store duties auto-run. Local repo duties remain repo-owned.

## Goals

Store goals are inactive templates. Consumer repos may also define local goal templates.

```text
.kody/goals/templates/<slug>/state.json
.kody/goals/instances/<id>/state.json
```

String activation keeps the old behavior: it activates existing instances by id or by template.

```json
{ "company": { "activeGoals": ["web-release"] } }
```

Scheduled activation creates a fresh instance from the template for each time bucket, persists it to `kody-state`, then ticks that instance.

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
