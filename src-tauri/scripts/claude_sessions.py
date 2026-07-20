import base64
import glob
import json
import os
import re
import sys
import time


GOALS_PATH = os.path.expanduser(os.path.join("~", ".muxpit", "session-goals.json"))
MAX_GOAL_TEXT = 2000
MAX_GOALS = 500

SETTINGS_PATH = os.path.expanduser(os.path.join("~", ".muxpit", "session-settings.json"))
MAX_SETTING_VALUE = 100
MAX_SESSION_SETTINGS = 500

LIST_TAIL_BYTES = 256 * 1024
HISTORY_TAIL_BYTES = 1024 * 1024
MAX_HISTORY_ITEMS = 200
MAX_ITEM_CHARS = 12000
MAX_LISTED_SESSIONS = 100
MAX_SCANNED_SESSIONS = 600

# A running turn keeps appending to the session file, so a recent write means
# the session is likely active right now. Computed against the host clock so
# client clock skew cannot distort it.
ACTIVE_WINDOW_SEC = 30

# Conversations claude can resume are UUID-named. The projects tree also holds
# subagent/teammate transcripts (agent-*.jsonl) that `claude --resume` rejects,
# so anything else must stay out of the session list.
SESSION_ID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z",
    re.IGNORECASE,
)


def resumable_session_file(path):
    return SESSION_ID_RE.match(os.path.splitext(os.path.basename(path))[0]) is not None


# claude also spawns one-shot internal sessions (conversation summarizers) that
# are resumable but were never driven by a person, and they outnumber real
# conversations. A prompt submitted through the normal input path — typed, or
# fed to `-p` over stdin the way muxpit drives it — records a "last-prompt"
# entry; the internal ones bypass that path, so it marks the real ones.
def user_driven_session(entries):
    return any(item.get("type") == "last-prompt" for item in entries)


def session_files(root):
    files = []
    for path in glob.iglob(os.path.join(root, "**", "*.jsonl"), recursive=True):
        if not resumable_session_file(path):
            continue
        try:
            files.append((os.path.getmtime(path), path))
        except OSError:
            continue
    return sorted(files, reverse=True)


def read_tail(path, byte_limit):
    size = os.path.getsize(path)
    with open(path, "rb") as stream:
        stream.seek(max(size - byte_limit, 0))
        if stream.tell() > 0:
            stream.readline()
        return stream.read().decode("utf-8", errors="replace").splitlines()


def json_items(lines):
    for line in lines:
        try:
            item = json.loads(line)
        except (TypeError, ValueError):
            continue
        if isinstance(item, dict):
            yield item


def message_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    )


def compact_json(value):
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


def trimmed(value):
    text = " ".join(str(value).split())
    return text if len(text) <= MAX_ITEM_CHARS else f"{text[:MAX_ITEM_CHARS - 1]}…"


def limited(value):
    text = str(value).strip()
    return text if len(text) <= MAX_ITEM_CHARS else f"{text[:MAX_ITEM_CHARS - 1]}…"


def session_metadata(path, updated_at, entries):
    title = ""
    cwd = ""
    for item in entries:
        cwd = item.get("cwd") or cwd
        if item.get("type") == "ai-title" and item.get("aiTitle"):
            title = trimmed(item["aiTitle"])
            continue
        if item.get("type") != "user" or item.get("sourceToolAssistantUUID"):
            continue
        message = item.get("message") if isinstance(item.get("message"), dict) else {}
        text = trimmed(message_text(message.get("content")))
        if text and not text.startswith("<"):
            title = text[:120]
    return {
        "id": os.path.splitext(os.path.basename(path))[0],
        "title": title or "Claude session",
        "cwd": cwd,
        "updatedAt": int(updated_at),
        "provider": "claude",
        "active": time.time() - updated_at < ACTIVE_WINDOW_SEC,
    }


def tool_result_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return compact_json(content)


def history_items(entries):
    result = []
    for line_index, item in enumerate(entries):
        if item.get("isSidechain"):
            continue
        item_type = item.get("type")
        message = item.get("message") if isinstance(item.get("message"), dict) else {}
        content = message.get("content")
        item_id = str(item.get("uuid") or f"history-{line_index}")

        if item_type == "user":
            text = limited(message_text(content))
            if text and not item.get("sourceToolAssistantUUID"):
                result.append({"id": item_id, "kind": "user", "text": text})
            if isinstance(content, list):
                for block_index, block in enumerate(content):
                    if not isinstance(block, dict) or block.get("type") != "tool_result":
                        continue
                    tool_text = limited(tool_result_text(block.get("content")))
                    if tool_text:
                        result.append({
                            "id": f"{item_id}-tool-result-{block_index}",
                            "kind": "tool",
                            "title": "Tool result",
                            "text": tool_text,
                        })
            continue

        if item_type != "assistant" or not isinstance(content, list):
            continue
        for block_index, block in enumerate(content):
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text":
                text = limited(block.get("text", ""))
                if text:
                    result.append({
                        "id": f"{item_id}-text-{block_index}",
                        "kind": "assistant",
                        "text": text,
                    })
            elif block_type == "tool_use":
                result.append({
                    "id": f"{item_id}-tool-{block_index}",
                    "kind": "tool",
                    "title": trimmed(block.get("name") or "Tool"),
                    "text": limited(compact_json(block.get("input"))),
                })
    return result[-MAX_HISTORY_ITEMS:]


def list_sessions(root):
    sessions = []
    # Internal sessions are filtered per file rather than after a slice of the
    # newest ones, or they would eat most of the returned list. The scan is
    # still bounded so a large tree cannot outrun the caller's timeout.
    for updated_at, path in session_files(root)[:MAX_SCANNED_SESSIONS]:
        if len(sessions) >= MAX_LISTED_SESSIONS:
            break
        try:
            entries = list(json_items(read_tail(path, LIST_TAIL_BYTES)))
        except OSError:
            continue
        if not user_driven_session(entries):
            continue
        sessions.append(session_metadata(path, updated_at, entries))
    print(json.dumps({"type": "muxpit_sessions", "sessions": sessions}), flush=True)


def load_session(root, session_id):
    matches = []
    pattern = os.path.join(root, "**", f"{glob.escape(session_id)}.jsonl")
    for path in glob.iglob(pattern, recursive=True):
        try:
            matches.append((os.path.getmtime(path), path))
        except OSError:
            continue
    if not matches:
        print(json.dumps({
            "type": "muxpit_error",
            "message": "Claude session was not found",
        }), flush=True)
        return
    updated_at, path = max(matches)
    try:
        entries = list(json_items(read_tail(path, HISTORY_TAIL_BYTES)))
    except OSError:
        print(json.dumps({
            "type": "muxpit_error",
            "message": "Claude session could not be read",
        }), flush=True)
        return
    print(json.dumps({
        "type": "muxpit_claude_session",
        "session": session_metadata(path, updated_at, entries),
        "items": history_items(entries),
    }), flush=True)


# Session goals live on the host so every muxpit surface (desktop, mobile)
# connecting to it sees the same goal for a session. Keys are
# "<provider>:<session-id>"; writes are atomic (tmp + rename).
def load_goals():
    try:
        with open(GOALS_PATH, "r", encoding="utf-8") as stream:
            data = json.load(stream)
    except (OSError, ValueError):
        return {}
    goals = data.get("goals") if isinstance(data, dict) else None
    return goals if isinstance(goals, dict) else {}


def save_goals(goals):
    os.makedirs(os.path.dirname(GOALS_PATH), exist_ok=True)
    tmp_path = GOALS_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as stream:
        json.dump({"version": 1, "goals": goals}, stream, ensure_ascii=False)
    os.replace(tmp_path, GOALS_PATH)


def print_goals(goals):
    print(json.dumps({"type": "muxpit_goals", "goals": goals}), flush=True)


def fail(message):
    print(json.dumps({"type": "muxpit_error", "message": message}), flush=True)


def normalized_goal(value):
    if not isinstance(value, dict):
        return None
    text = value.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    status = value.get("status")
    updated_at = value.get("updatedAt")
    return {
        "text": text.strip()[:MAX_GOAL_TEXT],
        "status": status if status in ("active", "done") else "active",
        "updatedAt": updated_at if isinstance(updated_at, int) else 0,
    }


def set_goal(key, encoded_payload):
    try:
        payload = json.loads(base64.b64decode(encoded_payload).decode("utf-8"))
    except (TypeError, ValueError):
        fail("Invalid goal payload")
        return
    goal = normalized_goal(payload)
    if goal is None:
        fail("Goal text is required")
        return
    goals = load_goals()
    goals[key] = goal
    if len(goals) > MAX_GOALS:
        def goal_age(item):
            return item[1].get("updatedAt", 0) if isinstance(item[1], dict) else 0
        ordered = sorted(goals.items(), key=goal_age)
        goals = dict(ordered[len(ordered) - MAX_GOALS:])
    save_goals(goals)
    print_goals(goals)


def delete_goal(key):
    goals = load_goals()
    goals.pop(key, None)
    save_goals(goals)
    print_goals(goals)


# Session execution settings (model/effort/service tier) live on the host for
# the same reason as goals: every muxpit surface loading a session should see
# the settings it was last driven with. Keys are "<provider>:<session-id>".
def load_settings():
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as stream:
            data = json.load(stream)
    except (OSError, ValueError):
        return {}
    settings = data.get("settings") if isinstance(data, dict) else None
    return settings if isinstance(settings, dict) else {}


def save_settings(settings):
    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    tmp_path = SETTINGS_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as stream:
        json.dump({"version": 1, "settings": settings}, stream, ensure_ascii=False)
    os.replace(tmp_path, SETTINGS_PATH)


def print_settings(settings):
    print(json.dumps({"type": "muxpit_session_settings", "settings": settings}), flush=True)


def setting_value(value):
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()[:MAX_SETTING_VALUE]


def normalized_setting(value):
    if not isinstance(value, dict):
        return None
    updated_at = value.get("updatedAt")
    return {
        "model": setting_value(value.get("model")),
        "effort": setting_value(value.get("effort")),
        "serviceTier": setting_value(value.get("serviceTier")),
        "updatedAt": updated_at if isinstance(updated_at, int) else 0,
    }


def set_setting(key, encoded_payload):
    try:
        payload = json.loads(base64.b64decode(encoded_payload).decode("utf-8"))
    except (TypeError, ValueError):
        fail("Invalid settings payload")
        return
    setting = normalized_setting(payload)
    if setting is None:
        fail("Settings payload must be an object")
        return
    settings = load_settings()
    settings[key] = setting
    if len(settings) > MAX_SESSION_SETTINGS:
        def setting_age(item):
            return item[1].get("updatedAt", 0) if isinstance(item[1], dict) else 0
        ordered = sorted(settings.items(), key=setting_age)
        settings = dict(ordered[len(ordered) - MAX_SESSION_SETTINGS:])
    save_settings(settings)
    print_settings(settings)


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "list"
    if command == "goals":
        print_goals(load_goals())
        return
    if command == "goal-set":
        if len(sys.argv) < 4:
            raise SystemExit("goal-set requires a key and a payload")
        set_goal(sys.argv[2], sys.argv[3])
        return
    if command == "goal-delete":
        if len(sys.argv) < 3:
            raise SystemExit("goal-delete requires a key")
        delete_goal(sys.argv[2])
        return
    if command == "settings":
        print_settings(load_settings())
        return
    if command == "setting-set":
        if len(sys.argv) < 4:
            raise SystemExit("setting-set requires a key and a payload")
        set_setting(sys.argv[2], sys.argv[3])
        return
    if command == "history":
        if len(sys.argv) < 3:
            raise SystemExit("history requires a session id")
        root = sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser("~/.claude/projects")
        load_session(root, sys.argv[2])
        return
    root = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/.claude/projects")
    list_sessions(root)


if __name__ == "__main__":
    main()
