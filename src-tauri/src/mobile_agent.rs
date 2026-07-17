use crate::agent_launch_settings::{claude_launch_args, AgentLaunchSettings};
use crate::shell_quote::quote_posix_shell_arg;
use base64::Engine;
use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State, Webview};
use tokio::sync::RwLock;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_LINE_BYTES: usize = 12 * 1024 * 1024;
const SSH_CREDENTIAL_SERVICE: &str = "com.wmux.terminal.ssh";
const HOST_PROFILE_SERVICE: &str = "com.wmux.terminal.hosts";
const HOST_PROFILE_ENTRY: &str = "profiles";

const CLAUDE_SESSION_SCRIPT: &str = include_str!("../scripts/claude_sessions.py");

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

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SshAuth {
    Password {
        password: String,
    },
    PrivateKey {
        private_key: String,
        passphrase: Option<String>,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileHostProfile {
    id: String,
    name: String,
    host: String,
    port: u16,
    user: String,
    cwd: String,
    trusted_fingerprint: Option<String>,
}

fn valid_credential_profile_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

#[cfg(target_os = "android")]
static CREDENTIAL_STORE: OnceLock<Result<(), String>> = OnceLock::new();

#[cfg(target_os = "android")]
async fn initialize_android_credential_context(webview: Webview) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            platform_webview
                .jni_handle()
                .exec(move |env, activity, _webview| {
                    let result = (|| {
                        let context = env
                            .call_method(
                                activity,
                                "getApplicationContext",
                                "()Landroid/content/Context;",
                                &[],
                            )?
                            .l()?;
                        android_native_keyring_store::Java_io_crates_keyring_Keyring_00024Companion_initializeNdkContext(
                            unsafe { env.unsafe_clone() },
                            jni::objects::JObject::null(),
                            context,
                        );
                        Ok::<(), jni::errors::Error>(())
                    })()
                    .map_err(|error| format!("Could not initialize secure credential storage: {error}"));
                    let _ = tx.send(result);
                });
        })
        .map_err(|error| format!("Could not access the Android webview: {error}"))?;
    rx.await
        .map_err(|_| "Could not initialize secure credential storage".to_string())?
}

#[cfg(target_os = "android")]
fn secure_entry(service: &str, entry_id: &str) -> Result<keyring_core::Entry, String> {
    if !valid_credential_profile_id(entry_id) {
        return Err("Invalid credential profile id".into());
    }
    CREDENTIAL_STORE
        .get_or_init(|| {
            let configuration = HashMap::from([("name", "wmux-ssh")]);
            let store = android_native_keyring_store::Store::new_with_configuration(&configuration)
                .map_err(|error| format!("Could not open secure credential storage: {error}"))?;
            keyring_core::set_default_store(store);
            Ok(())
        })
        .clone()?;
    keyring_core::Entry::new(service, entry_id)
        .map_err(|error| format!("Could not open secure storage entry: {error}"))
}

#[cfg(target_os = "android")]
fn credential_entry(profile_id: &str) -> Result<keyring_core::Entry, String> {
    secure_entry(SSH_CREDENTIAL_SERVICE, profile_id)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn mobile_credential_save(
    webview: Webview,
    profile_id: String,
    auth: SshAuth,
) -> Result<(), String> {
    initialize_android_credential_context(webview).await?;
    let secret = serde_json::to_vec(&auth)
        .map_err(|error| format!("Could not encode SSH credential: {error}"))?;
    credential_entry(&profile_id)?
        .set_secret(&secret)
        .map_err(|error| format!("Could not save SSH credential: {error}"))
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn mobile_credential_load(
    webview: Webview,
    profile_id: String,
) -> Result<Option<SshAuth>, String> {
    initialize_android_credential_context(webview).await?;
    let secret = match credential_entry(&profile_id)?.get_secret() {
        Ok(secret) => secret,
        Err(keyring_core::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(format!("Could not load SSH credential: {error}")),
    };
    serde_json::from_slice(&secret)
        .map(Some)
        .map_err(|error| format!("Could not decode SSH credential: {error}"))
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn mobile_profiles_save(
    webview: Webview,
    profiles: Vec<MobileHostProfile>,
) -> Result<(), String> {
    initialize_android_credential_context(webview).await?;
    let secret = serde_json::to_vec(&profiles)
        .map_err(|error| format!("Could not encode host profiles: {error}"))?;
    secure_entry(HOST_PROFILE_SERVICE, HOST_PROFILE_ENTRY)?
        .set_secret(&secret)
        .map_err(|error| format!("Could not save host profiles: {error}"))
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn mobile_profiles_load(webview: Webview) -> Result<Vec<MobileHostProfile>, String> {
    initialize_android_credential_context(webview).await?;
    let secret = match secure_entry(HOST_PROFILE_SERVICE, HOST_PROFILE_ENTRY)?.get_secret() {
        Ok(secret) => secret,
        Err(keyring_core::Error::NoEntry) => return Ok(Vec::new()),
        Err(error) => return Err(format!("Could not load host profiles: {error}")),
    };
    serde_json::from_slice(&secret)
        .map_err(|error| format!("Could not decode host profiles: {error}"))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn mobile_credential_save(_profile_id: String, _auth: SshAuth) -> Result<(), String> {
    Err("Secure credential storage is only available on Android".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn mobile_credential_load(_profile_id: String) -> Result<Option<SshAuth>, String> {
    Err("Secure credential storage is only available on Android".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn mobile_profiles_save(_profiles: Vec<MobileHostProfile>) -> Result<(), String> {
    Err("Secure profile storage is only available on Android".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn mobile_profiles_load() -> Result<Vec<MobileHostProfile>, String> {
    Err("Secure profile storage is only available on Android".into())
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
    settings: Option<AgentLaunchSettings>,
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
            format!(
                "{prefix}exec codex --dangerously-bypass-approvals-and-sandbox app-server --listen stdio://"
            )
        }
        MobileAgentProvider::Claude => {
            let settings = claude_launch_args(settings.as_ref())?;
            let resume = match session_id {
                Some(id) if valid_session_id(&id) => {
                    format!(" --resume {}", quote_posix_shell_arg(&id))
                }
                Some(_) => return Err("Invalid Claude session id".into()),
                None => String::new(),
            };
            format!(
                "{prefix}exec claude --dangerously-skip-permissions -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose{settings}{resume}"
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

#[tauri::command]
pub async fn mobile_ssh_probe(state: State<'_, MobileSshManager>) -> Result<bool, String> {
    let session = state.session.read().await;
    let Some(session) = session.as_ref() else {
        return Ok(false);
    };
    let channel = match tokio::time::timeout(PROBE_TIMEOUT, session.channel_open_session()).await {
        Ok(Ok(channel)) => channel,
        Ok(Err(_)) | Err(_) => return Ok(false),
    };
    let _ = channel.close().await;
    Ok(true)
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

async fn open_claude_session_script(
    app: AppHandle,
    state: State<'_, MobileSshManager>,
    channel_id: String,
    arguments: &[&str],
) -> Result<(), String> {
    let script = base64::engine::general_purpose::STANDARD.encode(CLAUDE_SESSION_SCRIPT);
    let python = format!("import base64;exec(base64.b64decode({script:?}))");
    let mut command = format!("exec python3 -u -c {}", quote_posix_shell_arg(&python));
    for argument in arguments {
        command.push(' ');
        command.push_str(&quote_posix_shell_arg(argument));
    }
    open_channel(app, state, channel_id, login_shell_command(&command)).await
}

#[tauri::command]
pub async fn mobile_agent_open(
    app: AppHandle,
    state: State<'_, MobileSshManager>,
    channel_id: String,
    provider: MobileAgentProvider,
    session_id: Option<String>,
    cwd: Option<String>,
    settings: Option<AgentLaunchSettings>,
) -> Result<(), String> {
    let command = agent_command(provider, session_id, cwd, settings)?;
    open_channel(app, state, channel_id, command).await
}

#[tauri::command]
pub async fn mobile_claude_sessions(
    app: AppHandle,
    state: State<'_, MobileSshManager>,
    channel_id: String,
) -> Result<(), String> {
    open_claude_session_script(app, state, channel_id, &["list"]).await
}

#[tauri::command]
pub async fn mobile_claude_session(
    app: AppHandle,
    state: State<'_, MobileSshManager>,
    channel_id: String,
    session_id: String,
) -> Result<(), String> {
    if !valid_session_id(&session_id) {
        return Err("Invalid Claude session id".into());
    }
    open_claude_session_script(app, state, channel_id, &["history", &session_id]).await
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
pub async fn mobile_agent_probe(
    state: State<'_, MobileSshManager>,
    channel_id: String,
) -> Result<bool, String> {
    Ok(state.channels.read().await.contains_key(&channel_id))
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
            mobile_ssh_probe,
            mobile_credential_save,
            mobile_credential_load,
            mobile_profiles_save,
            mobile_profiles_load,
            mobile_agent_open,
            mobile_agent_probe,
            mobile_agent_write,
            mobile_agent_close,
            mobile_claude_sessions,
            mobile_claude_session,
        ])
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running wmux mobile application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_commands_bypass_permissions() {
        let codex = agent_command(MobileAgentProvider::Codex, None, None, None).unwrap();
        assert!(codex.contains(
            "exec codex --dangerously-bypass-approvals-and-sandbox app-server --listen stdio://"
        ));

        let claude = agent_command(
            MobileAgentProvider::Claude,
            None,
            None,
            Some(AgentLaunchSettings {
                model: Some("sonnet".into()),
                effort: Some("high".into()),
            }),
        )
        .unwrap();
        assert!(claude.contains(
                "exec claude --dangerously-skip-permissions -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose"
            ));
        assert!(claude.contains("--model 'sonnet' --effort 'high'"));
    }
}
