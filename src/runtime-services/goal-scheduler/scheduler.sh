#!/usr/bin/env bash
#
# goal-scheduler: instantiate scheduled goal templates and tick active managed
# goal instances from the configured Kody state repo.
set -euo pipefail

local_templates_dir=".kody/goals/templates"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
store_templates_dir="${KODY_GOAL_SCHEDULER_TEMPLATES_DIR:-.kody-engine/definitions/goals/templates}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[goal-scheduler] FATAL: python3 not found on PATH" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "[goal-scheduler] FATAL: gh not found on PATH" >&2
  exit 1
fi

PYTHONPATH="$script_dir${PYTHONPATH:+:$PYTHONPATH}" python3 - "$local_templates_dir" "$store_templates_dir" <<'PY'
import base64
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo
from managed_todo_state import (
    is_managed_todo_text,
    parse_todo_goal_state,
    serialize_todo_goal_state,
)

local_templates_dir = Path(sys.argv[1])
store_templates_dir = Path(sys.argv[2])
template_roots = [local_templates_dir, store_templates_dir]
local_todos_dir = Path(".kody/todos")
LOCAL_MODE = os.environ.get("KODY_GOAL_SCHEDULER_SKIP_PERSIST") == "1"

SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
INTERVAL = re.compile(r"^(\d+)([mhdw])$")
MANAGED_KEYS = ("type", "destination", "capabilities", "route", "facts", "blockers")


def gh(args: list[str], input_text: str | None = None) -> str:
    delays = gh_retry_delays()
    for attempt in range(len(delays) + 1):
        result = subprocess.run(
            ["gh", *args],
            input=input_text,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode == 0:
            return result.stdout
        message = result.stderr.strip() or result.stdout.strip() or f"gh exited {result.returncode}"
        if attempt < len(delays) and is_rate_limit_error(message):
            delay = delays[attempt]
            print(
                f"[goal-scheduler] gh rate limited; retrying in {delay:g}s "
                f"(attempt {attempt + 2}/{len(delays) + 1})",
                file=sys.stderr,
            )
            if delay > 0:
                time.sleep(delay)
            continue
        raise RuntimeError(message)
    raise RuntimeError("gh retry loop exhausted")


def gh_retry_delays() -> list[float]:
    raw = os.environ.get("KODY_GOAL_SCHEDULER_GH_RETRY_DELAYS", "1,3,10").strip()
    if not raw:
        return []
    delays: list[float] = []
    for item in raw.split(","):
        try:
            value = float(item.strip())
        except ValueError:
            continue
        if value >= 0:
            delays.append(value)
    return delays


def is_rate_limit_error(message: str) -> bool:
    lower = message.lower()
    return "api rate limit exceeded" in lower or ("rate limit" in lower and "http 403" in lower)


def is_not_found(err: Exception) -> bool:
    msg = str(err)
    return "HTTP 404" in msg or "Not Found" in msg


def load_config() -> dict:
    path = Path("kody.config.json")
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def active_goal_config(config: dict) -> tuple[set[str], list[dict]]:
    company = config.get("company") if isinstance(config.get("company"), dict) else {}
    goals = company.get("activeGoals", [])
    if not isinstance(goals, list):
        goals = []
    active: set[str] = set()
    schedules: list[dict] = []
    for item in goals:
        if isinstance(item, str):
            slug = item.strip()
            if slug and SLUG.match(slug):
                active.add(slug)
            continue
        if not isinstance(item, dict):
            continue
        template = item.get("template")
        every = item.get("every")
        if not isinstance(template, str) or not template.strip() or not SLUG.match(template.strip()):
            continue
        entry = {"template": template.strip()}
        if isinstance(every, str) and every.strip():
            entry["every"] = every.strip()
        if isinstance(item.get("idPrefix"), str) and item["idPrefix"].strip():
            entry["idPrefix"] = item["idPrefix"].strip()
        if isinstance(item.get("facts"), dict):
            entry["facts"] = item["facts"]
        preferred = item.get("preferredRunTime")
        if isinstance(preferred, dict):
            time_value = preferred.get("time")
            timezone_value = preferred.get("timezone")
            if isinstance(time_value, str) and isinstance(timezone_value, str):
                entry["preferredRunTime"] = {"time": time_value, "timezone": timezone_value}
        schedules.append(entry)
    return active, schedules


def selected_goal_filter() -> set[str]:
    raw = os.environ.get("KODY_GOAL_SCHEDULER_ONLY", "").strip()
    if not raw:
        return set()
    selected: set[str] = set()
    for item in re.split(r"[\s,]+", raw):
        slug = item.strip()
        if not slug:
            continue
        if not SLUG.match(slug):
            raise RuntimeError(f"KODY_GOAL_SCHEDULER_ONLY contains invalid goal slug: {slug}")
        selected.add(slug)
    return selected


def now_utc() -> datetime:
    raw = os.environ.get("KODY_GOAL_SCHEDULER_NOW", "").strip()
    if raw:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        return datetime.fromisoformat(raw).astimezone(timezone.utc)
    return datetime.now(timezone.utc)


def interval_seconds(every: str) -> int:
    match = INTERVAL.match(every)
    if not match:
        raise ValueError(f"unsupported schedule '{every}'")
    amount = int(match.group(1))
    unit = match.group(2)
    return amount * {"m": 60, "h": 3600, "d": 86400, "w": 604800}[unit]

def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_preferred_runtime(data: dict) -> tuple[tuple[str, str, int, ZoneInfo] | None, str | None]:
    preferred = data.get("preferredRunTime")
    if not isinstance(preferred, dict):
        return None, None
    time_value = preferred.get("time")
    timezone_value = preferred.get("timezone")
    if not isinstance(time_value, str) or not isinstance(timezone_value, str):
        return None, None
    match = re.match(r"^([01]\d|2[0-3]):([0-5]\d)$", time_value)
    if not match:
        return None, f"invalid preferred time: {time_value}"
    try:
        zone = ZoneInfo(timezone_value)
    except Exception:
        return None, f"invalid preferred timezone: {timezone_value}"
    preferred_minute = int(match.group(1)) * 60 + int(match.group(2))
    return (time_value, timezone_value, preferred_minute, zone), None


def preferred_runtime_wait_reason(schedule: dict, now: datetime) -> str | None:
    parsed, error = parse_preferred_runtime(schedule)
    if error:
        return error
    if parsed is None:
        return None
    time_value, timezone_value, preferred_minute, zone = parsed
    local = now.astimezone(zone)
    current_minute = local.hour * 60 + local.minute
    if current_minute < preferred_minute:
        due_at = local.replace(
            hour=preferred_minute // 60,
            minute=preferred_minute % 60,
            second=0,
            microsecond=0,
        )
        return f"waiting preferred time {time_value} {timezone_value} until {iso_z(due_at)}"
    return None


def bucket_suffix(every: str, now: datetime) -> str:
    match = INTERVAL.match(every)
    if not match:
        raise ValueError(f"unsupported schedule '{every}'")
    amount = int(match.group(1))
    unit = match.group(2)
    if amount == 1 and unit == "d":
        return now.strftime("%Y-%m-%d")
    if amount == 1 and unit == "w":
        year, week, _ = now.isocalendar()
        return f"{year}-W{week:02d}"
    if amount == 1 and unit == "h":
        return now.strftime("%Y-%m-%dT%H")
    return f"b{int(now.timestamp()) // interval_seconds(every)}"


def find_template(template: str) -> Path | None:
  for root in template_roots:
    candidate = root / template / "state.json"
    if candidate.exists():
      return candidate
  return None


def load_template_state(template: str) -> dict | None:
    template_path = find_template(template)
    if template_path is None:
        return None
    data = json.loads(template_path.read_text())
    return data if isinstance(data, dict) else None


def normalize_state_repo(raw: object, field: str = "state.repo") -> str:
  value = str(raw or "").strip()
  if value.startswith(("http://", "https://")):
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.netloc != "github.com":
      raise RuntimeError(f"kody.config.json: {field} must be a GitHub repository URL")
    value = parsed.path.strip("/").removesuffix(".git")
  parts = value.split("/")
  if len(parts) != 2 or not all(parts) or not all(SLUG.match(part) for part in parts):
    raise RuntimeError(f"kody.config.json: {field} must be owner/repo or https://github.com/owner/repo")
  return value


def state_target(config: dict) -> tuple[str, str]:
  if LOCAL_MODE:
    return "__local__", ""
  state = config.get("state") if isinstance(config.get("state"), dict) else {}
  explicit_state_repo = state.get("repo") or config.get("stateRepo")
  explicit_state_path = state.get("path") or config.get("statePath")
  if explicit_state_repo and explicit_state_path:
    return normalize_state_repo(explicit_state_repo), str(explicit_state_path).strip().strip("/")

  github = config.get("github") if isinstance(config.get("github"), dict) else {}
  owner = github.get("owner")
  repo = github.get("repo")
  if not isinstance(owner, str) or not owner or not isinstance(repo, str) or not repo:
      name_with_owner = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).strip()
      owner, repo = name_with_owner.split("/", 1)
  state_repo = explicit_state_repo or f"{owner}/kody-state"
  state_path = explicit_state_path or repo
  return normalize_state_repo(state_repo), str(state_path).strip().strip("/")


def todo_file_path(state_base: str, goal_id: str) -> str:
    prefix = f"{state_base}/" if state_base else ""
    return f"{prefix}todos/{goal_id}.json"


def local_goal_path(goal_id: str) -> Path:
    return local_todos_dir / f"{goal_id}.json"


def read_remote_file(state_repo: str, path: str) -> tuple[str, str] | None:
    try:
        meta = json.loads(gh(["api", f"/repos/{state_repo}/contents/{path}"]))
    except Exception as err:
        if is_not_found(err):
            return None
        raise
    content = meta.get("content")
    sha = meta.get("sha")
    if not isinstance(content, str) or not isinstance(sha, str):
        return None
    return base64.b64decode(content.replace("\n", "")).decode("utf-8"), sha


def read_remote_text(state_repo: str, path: str) -> str | None:
    file = read_remote_file(state_repo, path)
    return file[0] if file is not None else None


def read_remote_json(state_repo: str, path: str) -> dict | None:
    text = read_remote_text(state_repo, path)
    return json.loads(text) if text is not None else None


def remote_goal_exists(state_repo: str, state_base: str, goal_id: str) -> bool:
    if LOCAL_MODE:
        return local_goal_path(goal_id).exists()
    return read_remote_text(state_repo, todo_file_path(state_base, goal_id)) is not None


def persist_goal(state_repo: str, state_base: str, goal_id: str, state_text: str) -> None:
    if LOCAL_MODE:
        target = local_goal_path(goal_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(serialize_todo_goal_state(goal_id, json.loads(state_text), iso_z(now_utc())))
        return
    path = todo_file_path(state_base, goal_id)
    if remote_goal_exists(state_repo, state_base, goal_id):
        return
    content = serialize_todo_goal_state(goal_id, json.loads(state_text), iso_z(now_utc()))
    payload = {
        "message": f"chore(goals): create {goal_id}",
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
    }
    try:
        gh(["api", "--method", "PUT", f"/repos/{state_repo}/contents/{path}", "--input", "-"], json.dumps(payload))
    except Exception as err:
        if "HTTP 409" in str(err) or "HTTP 422" in str(err):
            return
        raise


def create_instance_from_template(
    state_repo: str,
    state_base: str,
    template: str,
    goal_id: str,
    now: datetime,
    facts_patch: dict | None = None,
) -> bool:
    if remote_goal_exists(state_repo, state_base, goal_id):
        return False
    template_path = find_template(template)
    if template_path is None:
        raise RuntimeError(f"template {template} not found")
    data = json.loads(template_path.read_text())
    facts = data.get("facts") if isinstance(data.get("facts"), dict) else {}
    facts.update(facts_patch or {})
    data["kind"] = "instance"
    data["template"] = template
    data["sourceTemplate"] = template
    data["state"] = "active"
    data["facts"] = facts
    data.setdefault("createdAt", now.isoformat().replace("+00:00", "Z"))
    data["updatedAt"] = now.isoformat().replace("+00:00", "Z")
    state_text = json.dumps(data, indent=2, sort_keys=True) + "\n"
    persist_goal(state_repo, state_base, goal_id, state_text)
    return True


def list_goal_ids(state_repo: str, state_base: str) -> list[str]:
    if LOCAL_MODE:
        if not local_todos_dir.exists():
            return []
        ids = []
        for path in local_todos_dir.glob("*.json"):
            text = path.read_text()
            if is_managed_todo_text(text):
                ids.append(path.stem)
        return sorted(ids)
    ids: set[str] = set()
    todos_base = f"{state_base}/todos" if state_base else "todos"
    try:
        entries = json.loads(gh(["api", f"/repos/{state_repo}/contents/{todos_base}"]))
    except Exception as err:
        if not is_not_found(err):
            raise
        entries = []
    if isinstance(entries, list):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name") if isinstance(entry, dict) else None
            if entry.get("type") == "file" and isinstance(name, str) and name.endswith(".json"):
                goal_id = name[:-5]
                todo_text = read_remote_text(state_repo, todo_file_path(state_base, goal_id))
                if todo_text is not None and is_managed_todo_text(todo_text):
                    ids.add(goal_id)
    return sorted(ids)


def read_goal_state(state_repo: str, state_base: str, goal_id: str) -> dict | None:
    if LOCAL_MODE:
        path = local_goal_path(goal_id)
        if not path.exists():
            return None
        text = path.read_text()
        if not is_managed_todo_text(text):
            return None
        return resolve_template_backed_goal_state(parse_todo_goal_state(goal_id, text))
    todo_text = read_remote_text(state_repo, todo_file_path(state_base, goal_id))
    if todo_text is not None:
        if not is_managed_todo_text(todo_text):
            return None
        return resolve_template_backed_goal_state(parse_todo_goal_state(goal_id, todo_text))
    return None


def schedule_prefix(schedule: dict) -> str:
    return str(schedule.get("idPrefix") or schedule["template"])


def schedule_key(schedule: dict) -> tuple[str, str]:
    return schedule["template"], schedule_prefix(schedule)


def goal_template(data: dict) -> str | None:
    template = data.get("template") or data.get("sourceTemplate") or data.get("templateId")
    return template if isinstance(template, str) else None


def resolve_template_backed_goal_state(data: dict) -> dict:
    template = goal_template(data)
    if not template:
        return data
    template_data = load_template_state(template)
    if not template_data:
        return data
    merged = dict(data)
    for key in (
        "type",
        "destination",
        "capabilities",
        "route",
        "schedule",
        "scheduleMode",
        "loopTarget",
        "preferredRunTime",
        "saveReport",
    ):
        if key in template_data:
            merged[key] = template_data[key]
        elif key in merged and key in (
            "schedule",
            "loopTarget",
            "preferredRunTime",
            "saveReport",
        ):
            del merged[key]
    template_facts = template_data.get("facts") if isinstance(template_data.get("facts"), dict) else {}
    runtime_facts = data.get("facts") if isinstance(data.get("facts"), dict) else {}
    merged["facts"] = {**template_facts, **runtime_facts}
    merged["state"] = data.get("state", "active")
    return merged


def is_managed_goal(data: dict) -> bool:
    return all(key in data for key in MANAGED_KEYS)


def is_scheduled_instance(goal_id: str, data: dict, schedule: dict) -> bool:
    template = goal_template(data)
    prefix = schedule_prefix(schedule)
    return template == schedule["template"] and goal_id.startswith(f"{prefix}-")


def parse_state_time(value: object) -> float:
    if not isinstance(value, str) or not value:
        return 0
    try:
        raw = value[:-1] + "+00:00" if value.endswith("Z") else value
        return datetime.fromisoformat(raw).timestamp()
    except Exception:
        return 0


def scheduled_instance_sort_key(goal_id: str) -> tuple[float, str]:
    data = goal_state_cache.get(goal_id)
    if not isinstance(data, dict):
        return 0, goal_id
    return parse_state_time(data.get("createdAt") or data.get("updatedAt")), goal_id


def goal_schedule_interval(data: dict) -> str | None:
    schedule = data.get("schedule")
    if not isinstance(schedule, str):
        return None
    every = schedule.strip()
    return every if INTERVAL.match(every) else None


def last_goal_tick_time(data: dict) -> float:
    schedule_state = data.get("scheduleState")
    if not isinstance(schedule_state, dict):
        return 0
    last_goal_tick_at = schedule_state.get("lastGoalTickAt")
    last_decision = schedule_state.get("lastDecision")
    if isinstance(last_goal_tick_at, str):
        return parse_state_time(last_goal_tick_at)
    if isinstance(last_decision, dict):
        return parse_state_time(last_decision.get("at"))
    return 0


def last_goal_dispatch_time(data: dict) -> float:
    schedule_state = data.get("scheduleState")
    if not isinstance(schedule_state, dict):
        return 0
    last_decision = schedule_state.get("lastDecision")
    if not isinstance(last_decision, dict) or last_decision.get("kind") != "dispatch":
        return 0
    return parse_state_time(last_decision.get("at"))


def preferred_daily_wait_reason(data: dict, now: datetime) -> str | None:
    parsed, error = parse_preferred_runtime(data)
    if error:
        return error
    if parsed is None:
        return None
    time_value, timezone_value, preferred_minute, zone = parsed
    local = now.astimezone(zone)
    preferred_today = local.replace(
        hour=preferred_minute // 60,
        minute=preferred_minute % 60,
        second=0,
        microsecond=0,
    )
    current_minute = local.hour * 60 + local.minute
    if current_minute < preferred_minute:
        return f"waiting preferred time {time_value} {timezone_value} until {iso_z(preferred_today)}"

    last_dispatch = last_goal_dispatch_time(data)
    if last_dispatch > 0:
        dispatched_local = datetime.fromtimestamp(last_dispatch, timezone.utc).astimezone(zone)
        if dispatched_local.date() == local.date():
            next_due = preferred_today + timedelta(days=1)
            return (
                f"already dispatched today at preferred time {time_value} {timezone_value}; "
                f"next eligible {iso_z(next_due)}"
            )
    return None


def schedule_wait_reason(data: dict, now: datetime, activation_every: str | None = None) -> str | None:
    schedule_state = data.get("scheduleState")
    lease = schedule_state.get("lease") if isinstance(schedule_state, dict) else None
    lease_expires = parse_state_time(lease.get("expiresAt")) if isinstance(lease, dict) else 0
    if lease_expires > now.timestamp():
        return f"leased until {iso_z(datetime.fromtimestamp(lease_expires, timezone.utc))}"
    every = activation_every or goal_schedule_interval(data)
    if not every:
        return None
    if every == "1d" and isinstance(data.get("preferredRunTime"), dict):
        return preferred_daily_wait_reason(data, now)
    last_tick = last_goal_tick_time(data)
    if last_tick <= 0:
        return None
    next_tick = last_tick + interval_seconds(every)
    if now.timestamp() >= next_tick:
        return None
    due_at = iso_z(datetime.fromtimestamp(next_tick, timezone.utc))
    return f"waiting schedule {every} until {due_at}"


def write_existing_goal_state(
    state_repo: str,
    state_base: str,
    goal_id: str,
    data: dict,
    message: str,
    sha: str | None,
) -> None:
    content = serialize_todo_goal_state(goal_id, data, iso_z(now_utc()))
    if LOCAL_MODE:
        local_goal_path(goal_id).write_text(content)
        return
    if not sha:
        raise RuntimeError(f"cannot update {goal_id}: missing state sha")
    payload = {
        "message": message,
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        "sha": sha,
    }
    gh(
        ["api", "--method", "PUT", f"/repos/{state_repo}/contents/{todo_file_path(state_base, goal_id)}", "--input", "-"],
        json.dumps(payload),
    )


def read_fresh_goal_for_update(state_repo: str, state_base: str, goal_id: str) -> tuple[dict, str | None] | None:
    if LOCAL_MODE:
        path = local_goal_path(goal_id)
        if not path.exists():
            return None
        text = path.read_text()
        if not is_managed_todo_text(text):
            return None
        return parse_todo_goal_state(goal_id, text), None
    file = read_remote_file(state_repo, todo_file_path(state_base, goal_id))
    if file is None or not is_managed_todo_text(file[0]):
        return None
    return parse_todo_goal_state(goal_id, file[0]), file[1]


def reserve_goal_tick(
    state_repo: str,
    state_base: str,
    goal_id: str,
    now: datetime,
    activation_every: str | None,
) -> tuple[str | None, str | None]:
    fresh = read_fresh_goal_for_update(state_repo, state_base, goal_id)
    if fresh is None:
        return None, "goal state disappeared"
    raw_data, sha = fresh
    data = resolve_template_backed_goal_state(raw_data)
    if data.get("state") != "active" or not is_managed_goal(data):
        return None, "goal is no longer active"
    wait_reason = schedule_wait_reason(data, now, activation_every)
    if wait_reason:
        return None, wait_reason

    lease_id = f"{os.getpid()}-{time.time_ns()}"
    acquired_at = iso_z(now)
    schedule_state = dict(raw_data.get("scheduleState")) if isinstance(raw_data.get("scheduleState"), dict) else {}
    schedule_state["lease"] = {
        "id": lease_id,
        "acquiredAt": acquired_at,
        "expiresAt": iso_z(now + timedelta(hours=1)),
    }
    raw_data["scheduleState"] = schedule_state
    try:
        write_existing_goal_state(
            state_repo,
            state_base,
            goal_id,
            raw_data,
            f"chore(loops): reserve {goal_id}",
            sha,
        )
    except Exception as err:
        if "HTTP 409" in str(err) or "HTTP 422" in str(err):
            return None, "claimed by another scheduler"
        raise
    return lease_id, None


def finish_goal_tick_reservation(
    state_repo: str,
    state_base: str,
    goal_id: str,
    lease_id: str,
    reserved_at: datetime,
) -> None:
    try:
        fresh = read_fresh_goal_for_update(state_repo, state_base, goal_id)
        if fresh is None:
            return
        raw_data, sha = fresh
        schedule_state = raw_data.get("scheduleState")
        if not isinstance(schedule_state, dict):
            return
        lease = schedule_state.get("lease")
        if not isinstance(lease, dict) or lease.get("id") != lease_id:
            return
        next_schedule_state = dict(schedule_state)
        next_schedule_state.pop("lease", None)
        at = iso_z(reserved_at)
        next_schedule_state["lastGoalTickAt"] = at
        next_schedule_state["lastDecision"] = {
            "kind": "idle",
            "reason": "scheduler dispatch completed without a newer Loop decision",
            "at": at,
        }
        raw_data["scheduleState"] = next_schedule_state
        write_existing_goal_state(
            state_repo,
            state_base,
            goal_id,
            raw_data,
            f"chore(loops): finish reservation {goal_id}",
            sha,
        )
    except Exception as err:
        if "HTTP 409" not in str(err) and "HTTP 422" not in str(err):
            print(f"[goal-scheduler] warning: failed to finish reservation for {goal_id} ({err})")


config = load_config()
active, schedules = active_goal_config(config)
only_goals = selected_goal_filter()
if only_goals:
    active = {goal_id for goal_id in active if goal_id in only_goals}
    schedules = [schedule for schedule in schedules if schedule["template"] in only_goals]
state_repo, state_base = state_target(config)
now = now_utc()
created: list[str] = []
errors: list[str] = []
goal_ids = list_goal_ids(state_repo, state_base)
if not active and not schedules and not goal_ids:
    if only_goals:
        print(
            "[goal-scheduler] no selected active goals or persisted Loops after "
            f"KODY_GOAL_SCHEDULER_ONLY={','.join(sorted(only_goals))}"
        )
    else:
        print("[goal-scheduler] no company.activeGoals configured and no persisted Loops")
    print("KODY_SKIP_AGENT=true")
    raise SystemExit(0)
goal_state_cache: dict[str, dict | None] = {}
scheduled_recurring = [schedule for schedule in schedules if schedule.get("every")]


def cached_goal_state(goal_id: str) -> dict | None:
    if goal_id not in goal_state_cache:
        goal_state_cache[goal_id] = read_goal_state(state_repo, state_base, goal_id)
    return goal_state_cache[goal_id]


scheduled_active: dict[tuple[str, str], set[str]] = {}
for goal_id in goal_ids:
    try:
        data = cached_goal_state(goal_id)
    except Exception:
        continue
    if not isinstance(data, dict) or data.get("state") != "active" or not is_managed_goal(data):
        continue
    for schedule in scheduled_recurring:
        if is_scheduled_instance(goal_id, data, schedule):
            scheduled_active.setdefault(schedule_key(schedule), set()).add(goal_id)
scheduled_selected = {
    key: {sorted(ids, key=scheduled_instance_sort_key)[0]} for key, ids in scheduled_active.items() if ids
}
selected_scheduled_ids = {goal_id for ids in scheduled_selected.values() for goal_id in ids}

for goal_id in sorted(active):
    try:
        if create_instance_from_template(state_repo, state_base, goal_id, goal_id, now):
            created.append(goal_id)
    except Exception as err:
        errors.append(f"{goal_id}: {err}")

for schedule in schedules:
    every = schedule.get("every")
    if not every:
        active.add(schedule["template"])
        continue
    try:
        suffix = bucket_suffix(every, now)
        prefix = schedule_prefix(schedule)
        running = scheduled_selected.get(schedule_key(schedule), set())
        wait_reason = preferred_runtime_wait_reason(schedule, now)
        if wait_reason:
            if running:
                active.update(running)
            print(f"[goal-scheduler] skip {schedule['template']}: {wait_reason}")
            continue
        if running:
            active.update(running)
            print(
                f"[goal-scheduler] skip {schedule['template']}: "
                f"active scheduled instance already running ({', '.join(sorted(running))})"
            )
            continue
        goal_id = f"{prefix}-{suffix}"
        active.add(goal_id)
        facts = schedule.get("facts") if isinstance(schedule.get("facts"), dict) else {}
        if create_instance_from_template(state_repo, state_base, schedule["template"], goal_id, now, facts):
            created.append(goal_id)
    except Exception as err:
        errors.append(f"{schedule['template']}: {err}")

for goal_id in created:
    print(f"[goal-scheduler] created goal instance {goal_id}")
for error in errors:
    print(f"[goal-scheduler] schedule skipped: {error}")

goal_ids = sorted(set(goal_ids) | set(created))
if not goal_ids:
    print("[goal-scheduler] no goal instances yet")
    print("KODY_SKIP_AGENT=true")
    raise SystemExit(0)

active_count = 0
managed_active = 0
for goal_id in goal_ids:
    try:
        data = cached_goal_state(goal_id)
    except Exception as err:
        print(f"[goal-scheduler] skip {goal_id}: failed to read state ({err})")
        continue
    if not isinstance(data, dict):
        continue
    template = goal_template(data)
    direct_loop = (
        data.get("scheduleMode") == "agentLoop"
        and template is None
        and goal_schedule_interval(data) is not None
    )
    selected = (
        not only_goals
        or goal_id in only_goals
        or (isinstance(template, str) and template in only_goals)
    )
    activated = (
        selected
        and (
            direct_loop
            or goal_id in active
            or (isinstance(template, str) and template in active)
            or goal_id in selected_scheduled_ids
        )
    )
    if not activated or data.get("state") != "active":
        continue
    active_count += 1
    managed = is_managed_goal(data)
    if not managed:
        print(f"[goal-scheduler] skip {goal_id}: todo file is not a managed goal")
        continue
    activation_schedule = next(
        (
            schedule
            for schedule in scheduled_recurring
            if is_scheduled_instance(goal_id, data, schedule)
        ),
        None,
    )
    activation_every = activation_schedule.get("every") if activation_schedule else None
    wait_reason = schedule_wait_reason(data, now, activation_every)
    if wait_reason:
        print(f"[goal-scheduler] skip {goal_id}: {wait_reason}")
        continue
    lease_id, lease_wait_reason = reserve_goal_tick(
        state_repo,
        state_base,
        goal_id,
        now,
        activation_every,
    )
    if not lease_id:
        print(f"[goal-scheduler] skip {goal_id}: {lease_wait_reason or 'not reserved'}")
        continue
    managed_active += 1
    print(f"[goal-scheduler] -> tick {goal_id} (goal-manager)")
    result = subprocess.run(["kody-engine", "implementation", "goal-manager", "--goal", goal_id], check=False)
    finish_goal_tick_reservation(state_repo, state_base, goal_id, lease_id, now)
    if result.returncode != 0:
        print(f"[goal-scheduler] tick {goal_id} failed (continuing)")

print(f"[goal-scheduler] scanned {len(goal_ids)} goal instance(s), active={active_count}, managed={managed_active}")
print("KODY_SKIP_AGENT=true")
PY
