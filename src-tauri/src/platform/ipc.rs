use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
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

pub fn start_ipc_server(app: AppHandle) {
    std::thread::spawn(move || {
        imp::server_loop(app);
    });
}

pub(super) fn handle_client(mut stream: std::fs::File, app: &AppHandle) -> Result<(), String> {
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|e| format!("Clone error: {e}"))?,
    );

    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => return Err(format!("Read error: {e}")),
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

        let resp = handle_request(&req, app);
        let _ = writeln!(stream, "{}", serde_json::to_string(&resp).unwrap());
    }

    Ok(())
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
                .unwrap_or("wmux");
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

            let _ = app.emit("wmux-notify", serde_json::Value::Object(payload));

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
            let token = req
                .params
                .get("agent_session_token")
                .and_then(|v| v.as_str());

            let authorized = workspace_id
                .zip(surface_id)
                .zip(token)
                .map(|((workspace_id, surface_id), token)| {
                    app.state::<crate::pty::PtyManager>()
                        .agent_session_token_matches(workspace_id, surface_id, token)
                })
                .unwrap_or(false);
            if !authorized {
                return IpcResponse {
                    ok: false,
                    data: None,
                    error: Some("Unauthorized agent-session request".to_string()),
                };
            }

            let mut payload = serde_json::Map::new();
            insert_optional_string(&mut payload, "workspace_id", workspace_id);
            insert_optional_string(&mut payload, "surface_id", surface_id);
            insert_optional_string(&mut payload, "source", source);
            insert_optional_string(&mut payload, "event", event);
            insert_optional_string(&mut payload, "session_id", session_id);
            insert_optional_string(&mut payload, "cwd", cwd);

            let _ = app.emit("wmux-agent-session", serde_json::Value::Object(payload));

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
        _ => IpcResponse {
            ok: false,
            data: None,
            error: Some(format!("Unknown method: {}", req.method)),
        },
    }
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
