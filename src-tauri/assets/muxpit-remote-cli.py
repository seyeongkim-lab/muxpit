#!/usr/bin/env python3
import json
import os
import socket
import sys


AGENTS = {"codex", "claude", "gemini", "copilot", "opencode"}
HOOK_EVENTS = {
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "PreToolUse",
    "PermissionRequest",
    "Notification",
    "ErrorOccurred",
    "SessionEnd",
    "SubagentStop",
}


def fail(message, code=2):
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(code)


def context():
    values = {
        "origin_workspace_id": os.environ.get("MUXPIT_WORKSPACE_ID"),
        "origin_surface_id": os.environ.get("MUXPIT_SURFACE_ID"),
        "control_token": os.environ.get("MUXPIT_CONTROL_TOKEN"),
    }
    missing = [name for name, value in values.items() if not value]
    if missing:
        fail("missing muxpit control context")
    return values


def take(args, index, option):
    if index + 1 >= len(args):
        fail(f"{option} requires a value")
    return args[index + 1]


def payload_string(payload, keys, limit=4096):
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:limit]
        if isinstance(value, list):
            for item in value:
                if isinstance(item, str) and item.strip():
                    return item.strip()[:limit]
    return None


def hook_request(argv):
    if len(argv) != 3 or argv[1] not in AGENTS or argv[2] not in HOOK_EVENTS:
        fail("usage: muxpit-cli hooks <agent> <event>")
    raw = sys.stdin.read(1_048_577)
    if len(raw) > 1_048_576:
        fail("hook payload is too large")
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    agent = argv[1]
    event = argv[2]
    params = context()
    params.update({"source": agent, "event": event})
    session_id = payload_string(
        payload,
        ["session_id", "sessionId", "conversation_id", "conversationId"],
        512,
    )
    cwd = payload_string(
        payload,
        [
            "cwd",
            "working_directory",
            "workingDirectory",
            "project_dir",
            "projectDir",
            "project_path",
            "projectPath",
            "workspacePaths",
        ],
    )
    if session_id:
        params["session_id"] = session_id
    if cwd:
        params["cwd"] = cwd

    if event == "UserPromptSubmit":
        params["status"] = payload_string(
            payload,
            ["prompt", "user_prompt", "userPrompt", "message", "text", "input"],
            512,
        ) or "working"
    elif event in {"Stop", "SubagentStop"}:
        params["status"] = payload_string(payload, ["message", "summary", "status"], 512) or "done"
    elif event == "PermissionRequest":
        detail = payload_string(payload, ["tool_name", "toolName", "command", "message"], 512)
        params["body"] = f"Permission requested: {detail}" if detail else "Permission requested"
    elif event == "Notification":
        params["body"] = payload_string(payload, ["message", "body", "text", "status"], 512) or "Needs attention"
    elif event == "ErrorOccurred":
        params["body"] = payload_string(payload, ["message", "error", "reason", "status"], 512) or "Agent error"

    return {"method": "agent-event", "params": params}


def request(argv):
    if not argv:
        fail("a command is required")
    command = argv[0]
    if command == "hooks":
        return hook_request(argv)
    if command == "browser":
        if len(argv) < 2 or argv[1] not in {"open", "navigate", "reload", "url", "snapshot", "console", "screenshot"}:
            fail("usage: muxpit-cli browser <open|navigate|reload|url|snapshot|console|screenshot>")
        method = f"browser-{argv[1]}"
        argv = [command] + argv[2:]
    else:
        method = "list-surfaces" if command == "list-panes" else "spawn-subagent" if command == "subagent" else command
    if method not in {"identify", "list-surfaces", "split", "spawn-subagent", "focus", "send-text", "read-screen", "browser-open", "browser-navigate", "browser-reload", "browser-url", "browser-snapshot", "browser-console", "browser-screenshot"}:
        fail(f"unknown command: {command}", 1)
    params = context()
    params["workspace_id"] = params["origin_workspace_id"]
    params["surface_id"] = params["origin_surface_id"]
    positional = []
    index = 1
    while index < len(argv):
        arg = argv[index]
        if arg in {"--workspace", "--workspace-id"}:
            params["workspace_id"] = take(argv, index, arg)
            index += 2
        elif arg in {"--surface", "--surface-id", "--pane"}:
            params["surface_id"] = take(argv, index, arg)
            index += 2
        elif arg == "--direction" and method in {"split", "spawn-subagent"}:
            params["direction"] = take(argv, index, arg)
            index += 2
        elif arg == "--command" and method in {"split", "spawn-subagent"}:
            params["command"] = take(argv, index, arg)
            index += 2
        elif arg == "--label" and method == "spawn-subagent":
            params["label"] = take(argv, index, arg)
            index += 2
        elif arg == "--enter" and method == "send-text":
            params["append_enter"] = True
            index += 1
        elif arg == "--rows" and method == "read-screen":
            params["rows"] = int(take(argv, index, arg))
            index += 2
        elif arg == "--":
            positional.extend(argv[index + 1 :])
            break
        elif arg.startswith("--"):
            fail(f"unknown {command} option: {arg}")
        else:
            positional.append(arg)
            index += 1
    if method in {"split", "spawn-subagent"}:
        params.setdefault("direction", "vertical")
    if method == "spawn-subagent":
        if positional != ["spawn"] or not params.get("command"):
            fail("usage: muxpit-cli subagent spawn --command <command>")
        params["parent_surface_id"] = params["origin_surface_id"]
        positional = []
    if method == "send-text":
        if not positional:
            fail("send-text requires text")
        params["text"] = " ".join(positional) + ("\r" if params.pop("append_enter", False) else "")
        positional = []
    elif positional and not method.startswith("browser-"):
        fail(f"{command} does not accept positional arguments")
    if method == "read-screen":
        rows = params.setdefault("rows", 24)
        if rows < 1 or rows > 500:
            fail("rows must be between 1 and 500")
    if method in {"browser-open", "browser-navigate"}:
        if len(positional) != 1:
            fail("usage: muxpit-cli browser <open|navigate> <url>")
        params["url"] = positional[0]
        positional = []
    elif method.startswith("browser-") and positional:
        fail(f"{command} does not accept positional arguments")
    return {"method": method, "params": params}


def main():
    port = os.environ.get("MUXPIT_CONTROL_PORT")
    if not port:
        fail("MUXPIT_CONTROL_PORT is missing")
    argv = sys.argv[1:]
    with socket.create_connection(("127.0.0.1", int(port)), timeout=6) as stream:
        stream.sendall((json.dumps(request(argv)) + "\n").encode())
        response = b""
        while not response.endswith(b"\n"):
            chunk = stream.recv(4096)
            if not chunk:
                break
            response += chunk
    value = json.loads(response)
    if not value.get("ok"):
        fail(value.get("error", "unknown error"), 1)
    data = value.get("data")
    if argv and argv[0] == "hooks":
        print("{}")
    else:
        print("OK" if data is None else json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
