import glob
import json
import os
import sys


LIST_TAIL_BYTES = 256 * 1024
HISTORY_TAIL_BYTES = 1024 * 1024
MAX_HISTORY_ITEMS = 200
MAX_ITEM_CHARS = 12000


def session_files(root):
    files = []
    for path in glob.iglob(os.path.join(root, "**", "*.jsonl"), recursive=True):
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
    for updated_at, path in session_files(root)[:100]:
        try:
            entries = list(json_items(read_tail(path, LIST_TAIL_BYTES)))
            sessions.append(session_metadata(path, updated_at, entries))
        except OSError:
            continue
    print(json.dumps({"type": "wmux_sessions", "sessions": sessions}), flush=True)


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
            "type": "wmux_error",
            "message": "Claude session was not found",
        }), flush=True)
        return
    updated_at, path = max(matches)
    try:
        entries = list(json_items(read_tail(path, HISTORY_TAIL_BYTES)))
    except OSError:
        print(json.dumps({
            "type": "wmux_error",
            "message": "Claude session could not be read",
        }), flush=True)
        return
    print(json.dumps({
        "type": "wmux_claude_session",
        "session": session_metadata(path, updated_at, entries),
        "items": history_items(entries),
    }), flush=True)


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "list"
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
