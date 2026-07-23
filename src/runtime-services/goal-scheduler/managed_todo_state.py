"""Managed-goal todo state contract for goal-scheduler.

The scheduler owns timing and dispatch. This module owns the todo JSON shape
used for managed goal state.
"""

import json


def is_managed_todo_text(text: str) -> bool:
    data = parse_json_object(text)
    return is_managed_todo_data(data) if data is not None else False


def is_managed_todo_data(data: dict) -> bool:
    return (
        data.get("managed") is True
        or data.get("managed") == "true"
        or data.get("managedModel") in ("agentGoal", "agentLoop")
    )


def parse_json_object(text: str) -> dict | None:
    try:
        data = json.loads(text)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def string_list(value: object) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def route_from_items(items: list[dict]) -> list[dict]:
    route: list[dict] = []
    for item in items:
        meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
        stage = meta.get("stage")
        evidence = meta.get("evidence") or item.get("id")
        capability = meta.get("capability")
        if isinstance(stage, str) and isinstance(evidence, str) and isinstance(capability, str):
            step = {"stage": stage, "evidence": evidence, "capability": capability}
            if isinstance(meta.get("args"), dict):
                step["args"] = meta["args"]
            if meta.get("saveReport") is True:
                step["saveReport"] = True
            route.append(step)
    return route


def parse_json_todo_goal_state(goal_id: str, data: dict) -> dict:
    items = [item for item in data.get("items", []) if isinstance(item, dict)] if isinstance(data.get("items"), list) else []
    raw_destination = data.get("destination") if isinstance(data.get("destination"), dict) else {}
    route = data.get("route") if isinstance(data.get("route"), list) else route_from_items(items)
    evidence = string_list(raw_destination.get("evidence")) or string_list(data.get("evidence"))
    if not evidence:
        evidence = [
            str((item.get("meta") if isinstance(item.get("meta"), dict) else {}).get("evidence") or item.get("id"))
            for item in items
            if item.get("id")
        ]
    facts = data.get("facts") if isinstance(data.get("facts"), dict) else {}
    facts = dict(facts)
    for item in items:
        meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
        key = meta.get("evidence") or item.get("id")
        if isinstance(key, str):
            facts[key] = item.get("completed") is True
    capabilities = string_list(data.get("capabilities"))
    if not capabilities:
        capabilities = [step["capability"] for step in route if isinstance(step.get("capability"), str)]
    outcome = data.get("description") if isinstance(data.get("description"), str) else raw_destination.get("outcome")
    parsed = dict(data)
    parsed.update(
        {
            "id": goal_id,
            "version": data.get("version", 1),
            "state": data.get("state", "active"),
            "type": data.get("type", "general"),
            "destination": {**raw_destination, "outcome": outcome if isinstance(outcome, str) else "", "evidence": evidence},
            "capabilities": capabilities,
            "route": route,
            "facts": facts,
            "blockers": string_list(data.get("blockers")),
        }
    )
    return parsed


def parse_todo_goal_state(goal_id: str, text: str) -> dict:
    data = parse_json_object(text)
    if data is None:
        raise ValueError(f"goal {goal_id} todo state must be JSON")
    return parse_json_todo_goal_state(goal_id, data)


def todo_items_from_state(data: dict, now: str) -> list[dict]:
    destination = data.get("destination") if isinstance(data.get("destination"), dict) else {}
    evidence = string_list(destination.get("evidence"))
    route = data.get("route") if isinstance(data.get("route"), list) else []
    facts = data.get("facts") if isinstance(data.get("facts"), dict) else {}
    route_by_evidence = {
        step.get("evidence"): step
        for step in route
        if isinstance(step, dict) and isinstance(step.get("evidence"), str)
    }
    if evidence:
        items = []
        for key in evidence:
            step = route_by_evidence.get(key) if isinstance(route_by_evidence.get(key), dict) else {}
            completed = facts.get(key) is True
            items.append(
                {
                    "id": key,
                    "title": step.get("stage") if isinstance(step.get("stage"), str) else key,
                    "body": "",
                    "assignee": None,
                    "completed": completed,
                    "createdAt": data.get("createdAt") if isinstance(data.get("createdAt"), str) else now,
                    "completedAt": data.get("updatedAt") if completed and isinstance(data.get("updatedAt"), str) else None,
                    "meta": {
                        "evidence": key,
                        **({"stage": step["stage"]} if isinstance(step.get("stage"), str) else {}),
                        **({"capability": step["capability"]} if isinstance(step.get("capability"), str) else {}),
                        **({"args": step["args"]} if isinstance(step.get("args"), dict) else {}),
                        **({"saveReport": True} if step.get("saveReport") is True else {}),
                    },
                }
            )
        return items
    return [
        {
            "id": capability,
            "title": capability,
            "body": "",
            "assignee": None,
            "completed": False,
            "createdAt": data.get("createdAt") if isinstance(data.get("createdAt"), str) else now,
            "completedAt": None,
            "meta": {"capability": capability},
        }
        for capability in string_list(data.get("capabilities"))
    ]


def serialize_todo_goal_state(goal_id: str, data: dict, now: str) -> str:
    destination = data.get("destination") if isinstance(data.get("destination"), dict) else {}
    outcome = destination.get("outcome") if isinstance(destination.get("outcome"), str) else ""
    record = dict(data)
    record["version"] = 1
    record["id"] = goal_id
    record["title"] = goal_id
    record["description"] = outcome
    record["createdAt"] = data.get("createdAt") if isinstance(data.get("createdAt"), str) else now
    record["managed"] = True
    record["managedModel"] = "agentLoop" if record.get("scheduleMode") == "agentLoop" or record.get("type") == "agentLoop" else "agentGoal"
    record["evidence"] = string_list(destination.get("evidence"))
    record["items"] = todo_items_from_state(data, now)
    return json.dumps(record, indent=2) + "\n"
