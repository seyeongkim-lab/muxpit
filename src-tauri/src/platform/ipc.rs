use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(unix)]
use super::ipc_unix as imp;
#[cfg(windows)]
use super::ipc_windows as imp;

#[derive(Debug, Deserialize)]
struct IpcRequest {
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct IpcResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

const MAX_REQUEST_BYTES: u64 = 1_048_576;

pub fn start_ipc_server(app: AppHandle) {
    std::thread::spawn(move || {
        imp::server_loop(app);
    });
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ControlRelay {
    port: Option<u16>,
}

impl ControlRelay {
    pub fn port(self) -> Option<u16> {
        self.port
    }
}

pub fn start_control_relay(app: AppHandle) -> ControlRelay {
    let listener = match bind_control_relay_listener() {
        Ok(listener) => listener,
        Err(error) => {
            log::warn!("Failed to bind SSH control relay: {error}");
            return ControlRelay::default();
        }
    };
    let port = listener.local_addr().ok().map(|address| address.port());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        if let Err(error) = handle_tcp_client(stream, &app) {
                            log::warn!("SSH control relay client error: {error}");
                        }
                    });
                }
                Err(error) => log::warn!("SSH control relay accept error: {error}"),
            }
        }
    });
    ControlRelay { port }
}

fn bind_control_relay_listener() -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())
}

pub(super) fn handle_client(mut stream: std::fs::File, app: &AppHandle) -> Result<(), String> {
    let reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|e| format!("Clone error: {e}"))?,
    );
    handle_lines(reader, &mut stream, app, false)
}

fn handle_tcp_client(mut stream: TcpStream, app: &AppHandle) -> Result<(), String> {
    let reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|e| format!("Clone error: {e}"))?,
    );
    handle_lines(reader, &mut stream, app, true)
}

fn handle_lines<R: BufRead, W: Write>(
    mut reader: R,
    stream: &mut W,
    app: &AppHandle,
    control_only: bool,
) -> Result<(), String> {
    let mut line = String::new();
    loop {
        line.clear();
        match read_request_line(&mut reader, &mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => return Err(error),
        }

        if line.trim().is_empty() {
            continue;
        }

        let req: IpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let resp = IpcResponse {
                    ok: false,
                    data: None,
                    error: Some(format!("Parse error: {e}")),
                };
                let _ = writeln!(stream, "{}", serde_json::to_string(&resp).unwrap());
                continue;
            }
        };

        let resp = if control_only && !is_control_method(&req.method) {
            IpcResponse {
                ok: false,
                data: None,
                error: Some("Method is not available through the SSH control relay".to_string()),
            }
        } else {
            handle_request(&req, app)
        };
        let _ = writeln!(stream, "{}", serde_json::to_string(&resp).unwrap());
    }

    Ok(())
}

fn read_request_line<R: BufRead>(reader: &mut R, line: &mut String) -> Result<usize, String> {
    let bytes = Read::by_ref(reader)
        .take(MAX_REQUEST_BYTES + 1)
        .read_line(line)
        .map_err(|error| format!("Read error: {error}"))?;
    if line.len() as u64 > MAX_REQUEST_BYTES {
        return Err("Request is too large".to_string());
    }
    Ok(bytes)
}

fn handle_request(req: &IpcRequest, app: &AppHandle) -> IpcResponse {
    match req.method.as_str() {
        "ping" => IpcResponse {
            ok: true,
            data: Some(serde_json::json!("pong")),
            error: None,
        },
        "notify" => {
            let title = req
                .params
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("muxpit");
            let body = req
                .params
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let workspace_id = req.params.get("workspace_id").and_then(|v| v.as_str());
            let surface_id = req.params.get("surface_id").and_then(|v| v.as_str());
            let source = req.params.get("source").and_then(|v| v.as_str());
            let event = req.params.get("event").and_then(|v| v.as_str());

            let mut payload = serde_json::Map::new();
            payload.insert("title".to_string(), serde_json::json!(title));
            payload.insert("body".to_string(), serde_json::json!(body));
            insert_optional_string(&mut payload, "workspace_id", workspace_id);
            insert_optional_string(&mut payload, "surface_id", surface_id);
            insert_optional_string(&mut payload, "source", source);
            insert_optional_string(&mut payload, "event", event);

            let _ = app.emit("muxpit-notify", serde_json::Value::Object(payload));

            IpcResponse {
                ok: true,
                data: None,
                error: None,
            }
        }
        "agent-session" => {
            let workspace_id = req.params.get("workspace_id").and_then(|v| v.as_str());
            let surface_id = req.params.get("surface_id").and_then(|v| v.as_str());
            let source = req.params.get("source").and_then(|v| v.as_str());
            let event = req.params.get("event").and_then(|v| v.as_str());
            let session_id = req.params.get("session_id").and_then(|v| v.as_str());
            let cwd = req.params.get("cwd").and_then(|v| v.as_str());
            let status = req.params.get("status").and_then(|v| v.as_str());
            let token = req
                .params
                .get("agent_session_token")
                .and_then(|v| v.as_str());

            let authorized = workspace_id
                .zip(surface_id)
                .zip(token)
                .map(|((workspace_id, surface_id), token)| {
                    app.state::<crate::pty::PtyManager>().access_token_matches(
                        workspace_id,
                        surface_id,
                        token,
                    )
                })
                .unwrap_or(false);
            if !authorized {
                return IpcResponse {
                    ok: false,
                    data: None,
                    error: Some("Unauthorized agent-session request".to_string()),
                };
            }
            let Some(session_id) = session_id.filter(|value| is_valid_agent_session_id(value))
            else {
                return IpcResponse {
                    ok: false,
                    data: None,
                    error: Some("Invalid agent session id".to_string()),
                };
            };

            let mut payload = serde_json::Map::new();
            insert_optional_string(&mut payload, "workspace_id", workspace_id);
            insert_optional_string(&mut payload, "surface_id", surface_id);
            insert_optional_string(&mut payload, "source", source);
            insert_optional_string(&mut payload, "event", event);
            insert_optional_string(&mut payload, "session_id", Some(session_id));
            insert_optional_string(&mut payload, "cwd", cwd);
            insert_optional_string(&mut payload, "status", status);

            let _ = app.emit("muxpit-agent-session", serde_json::Value::Object(payload));

            IpcResponse {
                ok: true,
                data: None,
                error: None,
            }
        }
        "list-workspaces" => {
            let registry = app.state::<crate::WorkspaceRegistry>();
            let list = registry.0.lock().unwrap().clone();
            match serde_json::to_value(&list) {
                Ok(v) => IpcResponse {
                    ok: true,
                    data: Some(v),
                    error: None,
                },
                Err(e) => IpcResponse {
                    ok: false,
                    data: None,
                    error: Some(format!("serialize error: {e}")),
                },
            }
        }
        method if is_control_method(method) => {
            let Some((workspace_id, surface_id, token)) = control_credentials(&req.params) else {
                return IpcResponse {
                    ok: false,
                    data: None,
                    error: Some("Missing muxpit control context".to_string()),
                };
            };
            let authorized = app.state::<crate::pty::PtyManager>().control_token_matches(
                workspace_id,
                surface_id,
                token,
            );
            if !authorized {
                return IpcResponse {
                    ok: false,
                    data: None,
                    error: Some("Unauthorized control request".to_string()),
                };
            }
            let mut params = req.params.clone();
            if let Some(object) = params.as_object_mut() {
                object.remove("control_token");
            }
            let result = if method == "agent-event" {
                handle_remote_agent_event(app, &params)
            } else {
                crate::control::dispatch(app, method, params)
            };
            match result {
                Ok(data) => IpcResponse {
                    ok: true,
                    data: Some(data),
                    error: None,
                },
                Err(error) => IpcResponse {
                    ok: false,
                    data: None,
                    error: Some(error),
                },
            }
        }
        _ => IpcResponse {
            ok: false,
            data: None,
            error: Some(format!("Unknown method: {}", req.method)),
        },
    }
}

fn is_control_method(method: &str) -> bool {
    matches!(
        method,
        "identify"
            | "list-surfaces"
            | "split"
            | "spawn-subagent"
            | "browser-navigate"
            | "browser-open"
            | "browser-reload"
            | "browser-url"
            | "browser-snapshot"
            | "browser-console"
            | "browser-screenshot"
            | "agent-event"
            | "focus"
            | "send-text"
            | "read-screen"
    )
}

fn handle_remote_agent_event(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let workspace_id = params
        .get("origin_workspace_id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Missing remote agent workspace".to_string())?;
    let surface_id = params
        .get("origin_surface_id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Missing remote agent surface".to_string())?;
    let source = params
        .get("source")
        .and_then(serde_json::Value::as_str)
        .filter(|value| is_known_agent_source(value))
        .ok_or_else(|| "Invalid remote agent source".to_string())?;
    let event = params
        .get("event")
        .and_then(serde_json::Value::as_str)
        .filter(|value| is_known_agent_event(value))
        .ok_or_else(|| "Invalid remote agent event".to_string())?;

    if let Some(session_id) = params.get("session_id").and_then(serde_json::Value::as_str) {
        if !is_valid_agent_session_id(session_id) {
            return Err("Invalid agent session id".to_string());
        }
        let mut payload = serde_json::Map::new();
        insert_optional_string(&mut payload, "workspace_id", Some(workspace_id));
        insert_optional_string(&mut payload, "surface_id", Some(surface_id));
        insert_optional_string(&mut payload, "source", Some(source));
        insert_optional_string(&mut payload, "event", Some(event));
        insert_optional_string(&mut payload, "session_id", Some(session_id));
        insert_limited_string(&mut payload, params, "cwd", 4096);
        insert_limited_string(&mut payload, params, "status", 512);
        app.emit("muxpit-agent-session", serde_json::Value::Object(payload))
            .map_err(|error| error.to_string())?;
    }

    let body = params
        .get("body")
        .and_then(serde_json::Value::as_str)
        .map(|value| value.chars().take(512).collect::<String>())
        .or_else(|| match event {
            "Stop" | "SubagentStop" => params
                .get("status")
                .and_then(serde_json::Value::as_str)
                .map(|value| value.chars().take(512).collect())
                .or_else(|| Some("Prompt completed".to_string())),
            _ => None,
        });
    if let Some(body) = body {
        let mut payload = serde_json::Map::new();
        insert_optional_string(&mut payload, "workspace_id", Some(workspace_id));
        insert_optional_string(&mut payload, "surface_id", Some(surface_id));
        insert_optional_string(&mut payload, "source", Some(source));
        insert_optional_string(&mut payload, "event", Some(event));
        insert_optional_string(&mut payload, "title", Some(agent_display_name(source)));
        insert_optional_string(&mut payload, "body", Some(&body));
        app.emit("muxpit-notify", serde_json::Value::Object(payload))
            .map_err(|error| error.to_string())?;
    }

    Ok(serde_json::Value::Null)
}

fn is_known_agent_source(value: &str) -> bool {
    matches!(
        value,
        "codex" | "claude" | "gemini" | "copilot" | "opencode"
    )
}

fn is_known_agent_event(value: &str) -> bool {
    matches!(
        value,
        "SessionStart"
            | "UserPromptSubmit"
            | "Stop"
            | "PreToolUse"
            | "PermissionRequest"
            | "Notification"
            | "ErrorOccurred"
            | "SessionEnd"
            | "SubagentStop"
    )
}

fn agent_display_name(source: &str) -> &'static str {
    match source {
        "codex" => "Codex",
        "claude" => "Claude Code",
        "gemini" => "Gemini CLI",
        "copilot" => "GitHub Copilot CLI",
        "opencode" => "OpenCode",
        _ => "Agent",
    }
}

fn insert_limited_string(
    map: &mut serde_json::Map<String, serde_json::Value>,
    params: &serde_json::Value,
    key: &str,
    limit: usize,
) {
    if let Some(value) = params.get(key).and_then(serde_json::Value::as_str) {
        let value = value.chars().take(limit).collect::<String>();
        insert_optional_string(map, key, Some(&value));
    }
}

fn control_credentials(params: &serde_json::Value) -> Option<(&str, &str, &str)> {
    Some((
        params.get("origin_workspace_id")?.as_str()?,
        params.get("origin_surface_id")?.as_str()?,
        params.get("control_token")?.as_str()?,
    ))
}

fn is_valid_agent_session_id(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 512
        && !trimmed.starts_with('-')
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn insert_optional_string(
    map: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: Option<&str>,
) {
    if let Some(value) = value {
        if !value.is_empty() {
            map.insert(key.to_string(), serde_json::json!(value));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_relay_binds_only_to_ipv4_loopback() {
        let listener = bind_control_relay_listener().unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        assert_ne!(address.port(), 0);
    }

    #[test]
    fn agent_session_id_uses_shell_safe_allowlist() {
        assert!(is_valid_agent_session_id(
            "11111111-2222-3333-4444-555555555555"
        ));
        assert!(is_valid_agent_session_id("abc.DEF_123:456"));
        assert!(!is_valid_agent_session_id(""));
        assert!(!is_valid_agent_session_id("--last"));
        assert!(!is_valid_agent_session_id("session with spaces"));
        assert!(!is_valid_agent_session_id("abc&calc"));
        assert!(!is_valid_agent_session_id("abc'quote"));
    }

    #[test]
    fn control_methods_and_credentials_are_explicit() {
        assert!(is_control_method("read-screen"));
        assert!(is_control_method("agent-event"));
        assert!(!is_control_method("notify"));
        let params = serde_json::json!({
            "origin_workspace_id": "ws",
            "origin_surface_id": "pane",
            "control_token": "secret"
        });
        assert_eq!(control_credentials(&params), Some(("ws", "pane", "secret")));
        assert!(control_credentials(&serde_json::json!({})).is_none());
    }

    #[test]
    fn remote_agent_event_allowlists_are_explicit() {
        assert!(is_known_agent_source("opencode"));
        assert!(!is_known_agent_source("shell"));
        assert!(is_known_agent_event("PermissionRequest"));
        assert!(is_known_agent_event("ErrorOccurred"));
        assert!(!is_known_agent_event("ExecuteCommand"));
    }

    #[test]
    fn request_reader_rejects_a_line_over_one_megabyte() {
        let mut input = std::io::Cursor::new(vec![b'x'; MAX_REQUEST_BYTES as usize + 1]);
        let mut line = String::new();
        assert_eq!(
            read_request_line(&mut input, &mut line).unwrap_err(),
            "Request is too large"
        );
    }
}
