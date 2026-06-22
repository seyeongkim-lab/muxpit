#![cfg_attr(not(unix), allow(dead_code))]

use crate::ServerMsg;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentSessionGrant {
    pub(crate) workspace_id: String,
    pub(crate) surface_id: String,
    pub(crate) token: String,
}

#[derive(Clone, Default)]
pub(crate) struct AgentSessionGrants(Arc<Mutex<Vec<AgentSessionGrant>>>);

impl AgentSessionGrants {
    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, Vec<AgentSessionGrant>> {
        self.0.lock().unwrap()
    }
}

#[derive(Debug, Deserialize)]
struct IpcRequest {
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct IpcResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread::JoinHandle;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    pub(crate) struct ServerAgentIpc {
        path: PathBuf,
        parent: PathBuf,
        stop: Arc<AtomicBool>,
        handle: Option<JoinHandle<()>>,
    }

    impl ServerAgentIpc {
        pub(crate) fn start(
            tx: mpsc::UnboundedSender<ServerMsg>,
            grants: AgentSessionGrants,
        ) -> Result<Self, String> {
            let (parent, path) = socket_paths();
            std::fs::create_dir_all(&parent)
                .map_err(|e| format!("failed to create agent IPC dir {}: {e}", parent.display()))?;
            std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("failed to secure agent IPC dir {}: {e}", parent.display()))?;
            let _ = std::fs::remove_file(&path);
            let listener = UnixListener::bind(&path)
                .map_err(|e| format!("failed to bind agent IPC socket {}: {e}", path.display()))?;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            listener
                .set_nonblocking(true)
                .map_err(|e| format!("failed to set agent IPC nonblocking mode: {e}"))?;

            let stop = Arc::new(AtomicBool::new(false));
            let thread_stop = stop.clone();
            let handle = std::thread::spawn(move || {
                while !thread_stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let tx = tx.clone();
                            let grants = grants.clone();
                            std::thread::spawn(move || handle_client(stream, &tx, &grants));
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        Err(_) => std::thread::sleep(Duration::from_millis(250)),
                    }
                }
            });

            Ok(Self {
                path,
                parent,
                stop,
                handle: Some(handle),
            })
        }

        pub(crate) fn socket_path(&self) -> Option<&Path> {
            Some(&self.path)
        }
    }

    impl Drop for ServerAgentIpc {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
            let _ = std::fs::remove_file(&self.path);
            let _ = std::fs::remove_dir(&self.parent);
        }
    }

    fn socket_paths() -> (PathBuf, PathBuf) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let parent =
            std::env::temp_dir().join(format!("wmux-server-{}-{nonce}", std::process::id()));
        let path = parent.join("wmux.sock");
        (parent, path)
    }

    fn handle_client(
        mut stream: UnixStream,
        tx: &mpsc::UnboundedSender<ServerMsg>,
        grants: &AgentSessionGrants,
    ) {
        let Ok(reader_stream) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(reader_stream);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
            if line.trim().is_empty() {
                continue;
            }
            let response = match serde_json::from_str::<IpcRequest>(&line) {
                Ok(req) => handle_request(req, tx, grants),
                Err(e) => IpcResponse {
                    ok: false,
                    data: None,
                    error: Some(format!("parse error: {e}")),
                },
            };
            let Ok(response) = serde_json::to_string(&response) else {
                break;
            };
            if writeln!(stream, "{response}").is_err() {
                break;
            }
        }
    }
}

#[cfg(not(unix))]
mod imp {
    use super::*;
    use std::path::Path;

    pub(crate) struct ServerAgentIpc;

    impl ServerAgentIpc {
        pub(crate) fn start(
            _tx: mpsc::UnboundedSender<ServerMsg>,
            _grants: AgentSessionGrants,
        ) -> Result<Self, String> {
            Ok(Self)
        }

        pub(crate) fn socket_path(&self) -> Option<&Path> {
            None
        }
    }
}

pub(crate) use imp::ServerAgentIpc;

fn handle_request(
    req: IpcRequest,
    tx: &mpsc::UnboundedSender<ServerMsg>,
    grants: &AgentSessionGrants,
) -> IpcResponse {
    match req.method.as_str() {
        "ping" => IpcResponse {
            ok: true,
            data: Some(Value::String("pong".to_string())),
            error: None,
        },
        "notify" => {
            emit_event(tx, "wmux-notify", notification_payload(&req.params));
            ok()
        }
        "agent-session" => handle_agent_session(req.params, tx, grants),
        _ => IpcResponse {
            ok: false,
            data: None,
            error: Some(format!("unknown method: {}", req.method)),
        },
    }
}

fn handle_agent_session(
    params: Value,
    tx: &mpsc::UnboundedSender<ServerMsg>,
    grants: &AgentSessionGrants,
) -> IpcResponse {
    let workspace_id = params.get("workspace_id").and_then(Value::as_str);
    let surface_id = params.get("surface_id").and_then(Value::as_str);
    let token = params.get("agent_session_token").and_then(Value::as_str);
    let authorized = workspace_id
        .zip(surface_id)
        .zip(token)
        .map(|((workspace_id, surface_id), token)| {
            token_matches(grants, workspace_id, surface_id, token)
        })
        .unwrap_or(false);
    if !authorized {
        return err("unauthorized agent-session request");
    }

    let Some(session_id) = params
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|value| is_valid_agent_session_id(value))
    else {
        return err("invalid agent session id");
    };

    let mut payload = serde_json::Map::new();
    insert_optional_string(&mut payload, "workspace_id", workspace_id);
    insert_optional_string(&mut payload, "surface_id", surface_id);
    insert_optional_string(
        &mut payload,
        "source",
        params.get("source").and_then(Value::as_str),
    );
    insert_optional_string(
        &mut payload,
        "event",
        params.get("event").and_then(Value::as_str),
    );
    insert_optional_string(&mut payload, "session_id", Some(session_id));
    insert_optional_string(
        &mut payload,
        "cwd",
        params.get("cwd").and_then(Value::as_str),
    );
    emit_event(tx, "wmux-agent-session", Value::Object(payload));
    ok()
}

fn token_matches(
    grants: &AgentSessionGrants,
    workspace_id: &str,
    surface_id: &str,
    token: &str,
) -> bool {
    if workspace_id.is_empty() || surface_id.is_empty() || token.is_empty() {
        return false;
    }
    grants.lock().iter().any(|grant| {
        grant.workspace_id == workspace_id && grant.surface_id == surface_id && grant.token == token
    })
}

fn notification_payload(params: &Value) -> Value {
    let mut payload = serde_json::Map::new();
    insert_optional_string(
        &mut payload,
        "title",
        params.get("title").and_then(Value::as_str).or(Some("wmux")),
    );
    insert_optional_string(
        &mut payload,
        "body",
        params.get("body").and_then(Value::as_str),
    );
    insert_optional_string(
        &mut payload,
        "workspace_id",
        params.get("workspace_id").and_then(Value::as_str),
    );
    insert_optional_string(
        &mut payload,
        "surface_id",
        params.get("surface_id").and_then(Value::as_str),
    );
    insert_optional_string(
        &mut payload,
        "source",
        params.get("source").and_then(Value::as_str),
    );
    insert_optional_string(
        &mut payload,
        "event",
        params.get("event").and_then(Value::as_str),
    );
    Value::Object(payload)
}

fn emit_event(tx: &mpsc::UnboundedSender<ServerMsg>, event: &str, payload: Value) {
    let _ = tx.send(ServerMsg::Event {
        event: event.to_string(),
        payload,
    });
}

fn ok() -> IpcResponse {
    IpcResponse {
        ok: true,
        data: None,
        error: None,
    }
}

fn err(message: &str) -> IpcResponse {
    IpcResponse {
        ok: false,
        data: None,
        error: Some(message.to_string()),
    }
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
    map: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<&str>,
) {
    if let Some(value) = value {
        if !value.is_empty() {
            map.insert(key.to_string(), Value::String(value.to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_matches_registered_grant() {
        let grants = AgentSessionGrants::default();
        grants.lock().push(AgentSessionGrant {
            workspace_id: "ws".to_string(),
            surface_id: "leaf".to_string(),
            token: "tok".to_string(),
        });

        assert!(token_matches(&grants, "ws", "leaf", "tok"));
        assert!(!token_matches(&grants, "ws", "leaf", "bad"));
    }

    #[test]
    fn agent_session_id_uses_shell_safe_allowlist() {
        assert!(is_valid_agent_session_id("abc.DEF_123:456"));
        assert!(!is_valid_agent_session_id(""));
        assert!(!is_valid_agent_session_id("--last"));
        assert!(!is_valid_agent_session_id("session with spaces"));
        assert!(!is_valid_agent_session_id("abc&calc"));
    }
}
