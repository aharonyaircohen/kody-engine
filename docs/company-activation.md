# Company Activation

The company store is a catalog. It is not an auto-run list.

Consumer repos decide which shared company model they activate in
`kody.config.json`:

```json
{
  "company": {
    "activeDuties": ["release"],
    "activeGoals": ["web-release"]
  }
}
```

## Duties

Store duties are inactive by default.

A store duty may declare `every`, `staff`, and `executable`, but those fields are
only used after the consumer lists the duty under `company.activeDuties`.

Missing or empty `company.activeDuties` means no store duties auto-run. Local
repo duties remain repo-owned.

## Goals

Store goals are inactive templates. Consumer repos may also define local goal templates.
Templates live under `.kody/goals/templates/<slug>/state.json`; live runs live under
`.kody/goals/instances/<id>/state.json`.

The consumer activates a goal through `company.activeGoals`, then creates or updates
a runtime goal instance with repo facts such as `facts.issue`. Missing or empty
`company.activeGoals` means no store goals auto-run.

## Rule

```text
kody-store = menu
consumer repo = decides what is enabled
activation = permission to run
```
