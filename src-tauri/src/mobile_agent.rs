use crate::shell_quote::quote_posix_shell_arg;
use base64::Engine;
use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_LINE_BYTES: usize = 1024 * 1024;

const CLAUDE_SESSION_SCAN: &str = r#"
import glob
import json
import os

sessions = []
root = os.path.expanduser("~/.claude/projects")
for path in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True):
    try:
        stat = os.stat(path)
        with open(path, "rb") as stream:
            stream.seek(max(stat.st_size - 262144, 0))
            if stream.tell() > 0:
                stream.readline()
            lines = stream.read().decode("utf-8", errors="replace").splitlines()
        cwd = ""
        title = ""
        for line in lines:
            try:
                item = json.loads(line)
            except (TypeError, ValueError):
                continue
            cwd = item.get("cwd") or cwd
            if item.get("type") != "user":
                continue
            content = (item.get("message") or {}).get("content")
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                text = " ".join(
                    block.get("text", "")
                    for block in content
                    if isinstance(block, dict) and block.get("type") == "text"
                )
            else:
                text = ""
            text = " ".join(text.split())
            if text and not text.startswith("<"):
                title = text[:120]
        sessions.append({
            "id": os.path.splitext(os.path.basename(path))[0],
            "title": title or "Claude session",
            "cwd": cwd,
            "updatedAt": int(stat.st_mtime),
            "provider": "claude",
        })
    except OSError:
        continue

sessions.sort(key=lambda item: item["updatedAt"], reverse=True)
print(json.dumps({"type": "wmux_sessions", "sessions": sessions[:100]}), flush=True)
"#;

#[derive(Clone)]
struct SshClient {
    expected_fingerprint: Option<String>,
    observed_fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key
            .fingerprint(ssh_key::HashAlg::Sha256)
            .to_string();
        *self.observed_fingerprint.lock().unwrap() = Some(fingerprint.clone());
        Ok(self
            .expected_fingerprint
            .as_ref()
            .map_or(true, |expected| expected == &fingerprint))
    }
}

type AgentWriter = ChannelWriteHalf<client::Msg>;

#[derive(Default)]
pub struct MobileSshManager {
    session: RwLock<Option<Handle<SshClient>>>,
    channels: Arc<RwLock<HashMap<String, Arc<AgentWriter>>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectRequest {
    host: String,
    port: u16,
    user: String,
    trusted_fingerprint: Option<String>,
    auth: SshAuth,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum SshAuth {
    Password {
        password: String,
    },
    PrivateKey {
        private_key: String,
        passphrase: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectResult {
    connected: bool,
    trust_required: bool,
    fingerprint: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileAgentTransportEvent {
    channel_id: String,
    kind: &'static str,
    data: Option<String>,
    exit_status: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MobileAgentProvider {
    Codex,
    Claude,
}

fn validate_connection(request: &SshConnectRequest) -> Result<(), String> {
    if request.host.is_empty()
        || request.host.len() > 255
        || request.host.chars().any(char::is_control)
    {
        return Err("Invalid SSH host".into());
    }
    if request.user.is_empty()
        || request.user.len() > 128
        || request.user.chars().any(char::is_control)
    {
        return Err("Invalid SSH user".into());
    }
    if request.port == 0 {
        return Err("Invalid SSH port".into());
    }
    Ok(())
}

fn valid_channel_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
}

fn valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.starts_with('-')
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
}

fn checked_cwd(value: Option<String>) -> Result<Option<String>, String> {
    match value {
        Some(cwd) if cwd.len() > 4096 || cwd.chars().any(char::is_control) => {
            Err("Invalid working directory".into())
        }
        other => Ok(other.filter(|cwd| !cwd.is_empty())),
    }
}

fn login_shell_command(command: &str) -> String {
    format!(
        "exec \"${{SHELL:-/bin/sh}}\" -lc {}",
        quote_posix_shell_arg(command)
    )
}

fn agent_command(
    provider: MobileAgentProvider,
    session_id: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let cwd = checked_cwd(cwd)?;
    let prefix = cwd
        .as_deref()
        .map(|path| format!("cd {} && ", quote_posix_shell_arg(path)))
        .unwrap_or_default();
    let command = match provider {
        MobileAgentProvider::Codex => {
            if session_id.is_some() {
                return Err("Codex sessions are resumed through app-server".into());
            }
            format!("{prefix}exec codex app-server --listen stdio://")
        }
        MobileAgentProvider::Claude => {
            let resume = match session_id {
                Some(id) if valid_session_id(&id) => {
                    format!(" --resume {}", quote_posix_shell_arg(&id))
                }
                Some(_) => return Err("Invalid Claude session id".into()),
                None => String::new(),
            };
            format!(
                "{prefix}exec claude -p --input-format stream-json --output-format stream-json --verbose{resume}"
            )
        }
    };
    Ok(login_shell_command(&command))
}

async fn authenticate(
    session: &mut Handle<SshClient>,
    user: &str,
    auth: SshAuth,
) -> Result<(), String> {
    let result = match auth {
        SshAuth::Password { password } => session
            .authenticate_password(user, password)
            .await
            .map_err(|error| format!("SSH password authentication failed: {error}"))?,
        SshAuth::PrivateKey {
            private_key,
            passphrase,
        } => {
            let private_key = decode_secret_key(&private_key, passphrase.as_deref())
                .map_err(|_| "Could not read the SSH private key".to_string())?;
            let hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(|error| format!("SSH key negotiation failed: {error}"))?
                .flatten();
            session
                .authenticate_publickey(
                    user,
                    PrivateKeyWithHashAlg::new(Arc::new(private_key), hash),
                )
                .await
                .map_err(|error| format!("SSH key authentication failed: {error}"))?
        }
    };
    if result.success() {
        Ok(())
    } else {
        Err("SSH authentication was rejected".into())
    }
}

#[tauri::command]
pub async fn mobile_ssh_connect(
    state: State<'_, MobileSshManager>,
    request: SshConnectRequest,
) -> Result<SshConnectResult, String> {
    validate_connection(&request)?;
    mobile_ssh_disconnect(state.clone()).await?;

    let observed_fingerprint = Arc::new(Mutex::new(None));
    let client = SshClient {
        expected_fingerprint: request.trusted_fingerprint.clone(),
        observed_fingerprint: Arc::clone(&observed_fingerprint),
    };
    let config = client::Config {
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    };
    let connection = client::connect(
        Arc::new(config),
        (request.host.as_str(), request.port),
        client,
    );
    let mut session = tokio::time::timeout(CONNECT_TIMEOUT, connection)
        .await
        .map_err(|_| "SSH connection timed out".to_string())?
        .map_err(|error| format!("SSH connection failed: {error}"))?;
    let fingerprint = observed_fingerprint
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "SSH server did not provide a host key".to_string())?;

    if request.trusted_fingerprint.is_none() {
        let _ = session
            .disconnect(Disconnect::ByApplication, "Host key confirmation", "en")
            .await;
        return Ok(SshConnectResult {
            connected: false,
            trust_required: true,
            fingerprint,
        });
    }

    authenticate(&mut session, &request.user, request.auth).await?;
    *state.session.write().await = Some(session);
    Ok(SshConnectResult {
        connected: true,
        trust_required: false,
        fingerprint,
    })
}

#[tauri::command]
pub async fn mobile_ssh_disconnect(state: State<'_, MobileSshManager>) -> Result<(), String> {
    let writers = {
        let mut channels = state.channels.write().await;
        channels
            .drain()
            .map(|(_, writer)| writer)
            .collect::<Vec<_>>()
    };
    for writer in writers {
        let _ = writer.close().await;
    }
    if let Some(session) = state.session.write().await.take() {
        let _ = session
            .disconnect(Disconnect::ByApplication, "Disconnected", "en")
            .await;
    }
    Ok(())
}

async fn open_channel(
    app: AppHandle,
    state: State<'_, MobileSshManager>,
    channel_id: String,
    command: String,
) -> Result<(), String> {
    if !valid_channel_id(&channel_id) {
        return Err("Invalid agent channel id".into());
    }
    if let Some(previous) = state.channels.write().await.remove(&channel_id) {
        let _ = previous.close().await;
    }

    let channel = {
        let session = state.session.read().await;
        let session = session
            .as_ref()
            .ok_or_else(|| "SSH is not connected".to_string())?;
        session
            .channel_open_session()
            .await
            .map_err(|error| format!("Could not open SSH channel: {error}"))?
    };
    channel
        .exec(true, command)
        .await
        .map_err(|error| format!("Could not start remote agent: {error}"))?;
    let (mut reader, writer) = channel.split();
    let writer = Arc::new(writer);
    state
        .channels
        .write()
        .await
        .insert(channel_id.clone(), Arc::clone(&writer));

    let channels = Arc::clone(&state.channels);
    tauri::async_runtime::spawn(async move {
        while let Some(message) = reader.wait().await {
            let event = match message {
                ChannelMsg::Data { data } => Some(MobileAgentTransportEvent {
                    channel_id: channel_id.clone(),
                    kind: "stdout",
                    data: Some(String::from_utf8_lossy(&data).into_owned()),
                    exit_status: None,
                }),
                ChannelMsg::ExtendedData { data, .. } => Some(MobileAgentTransportEvent {
                    channel_id: channel_id.clone(),
                    kind: "stderr",
                    data: Some(String::from_utf8_lossy(&data).into_owned()),
                    exit_status: None,
                }),
                ChannelMsg::ExitStatus { exit_status } => Some(MobileAgentTransportEvent {
                    channel_id: channel_id.clone(),
                    kind: "exit",
                    data: None,
                    exit_status: Some(exit_status),
                }),
                _ => None,
            };
            if let Some(event) = event {
                let _ = app.emit("mobile-agent-transport", event);
            }
        }
        channels.write().await.remove(&channel_id);
        let _ = app.emit(
            "mobile-agent-transport",
            MobileAgentTransportEvent {
                channel_id,
                kind: "closed",
                data: None,
                exit_status: None,
            },
        );
    });
    Ok(())
}

#[tauri::command]
pub async fn mobile_agent_open(
    app: AppHandle,
    state: State<'_, MobileSshManager>,
    channel_id: String,
    provider: MobileAgentProvider,
    session_id: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let command = agent_command(provider, session_id, cwd)?;
    open_channel(app, state, channel_id, command).await
}

#[tauri::command]
pub async fn mobile_claude_sessions(
    app: AppHandle,
    state: State<'_, MobileSshManager>,
    channel_id: String,
) -> Result<(), String> {
    let script = base64::engine::general_purpose::STANDARD.encode(CLAUDE_SESSION_SCAN);
    let inner = format!(
        "exec python3 -u -c {}",
        quote_posix_shell_arg(&format!("import base64;exec(base64.b64decode({script:?}))"))
    );
    open_channel(app, state, channel_id, login_shell_command(&inner)).await
}

#[tauri::command]
pub async fn mobile_agent_write(
    state: State<'_, MobileSshManager>,
    channel_id: String,
    line: String,
) -> Result<(), String> {
    if line.len() > MAX_LINE_BYTES || line.contains('\n') || line.contains('\r') {
        return Err("Invalid agent message".into());
    }
    let writer = state
        .channels
        .read()
        .await
        .get(&channel_id)
        .cloned()
        .ok_or_else(|| "Agent channel is not open".to_string())?;
    let data = format!("{line}\n");
    writer
        .data(data.as_bytes())
        .await
        .map_err(|error| format!("Could not write to remote agent: {error}"))
}

#[tauri::command]
pub async fn mobile_agent_close(
    state: State<'_, MobileSshManager>,
    channel_id: String,
) -> Result<(), String> {
    let writer = state
        .channels
        .write()
        .await
        .remove(&channel_id)
        .ok_or_else(|| "Agent channel is not open".to_string())?;
    writer
        .close()
        .await
        .map_err(|error| format!("Could not close remote agent: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(MobileSshManager::default())
        .invoke_handler(tauri::generate_handler![
            mobile_ssh_connect,
            mobile_ssh_disconnect,
            mobile_agent_open,
            mobile_agent_write,
            mobile_agent_close,
            mobile_claude_sessions,
        ])
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running wmux mobile application");
}
