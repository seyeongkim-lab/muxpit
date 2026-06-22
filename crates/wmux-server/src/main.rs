//! wmux-server: serve the wmux web frontend + a WebSocket/HTTP bridge to a
//! local engine, so a browser on another machine can drive this host.
//!
//! Browser runtime bridge: static serving, `readDir` over WS, file/dir download,
//! PTY IO, tmux/SSH RPCs, and monitor events for the full wmux UI.

mod agent_ipc;
mod monitor;

use agent_ipc::{AgentSessionGrant, AgentSessionGrants, ServerAgentIpc};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get},
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use monitor::ServerMonitorManager;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{Read, Write as _},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};
use tokio::sync::mpsc;
use tower_http::services::ServeDir;
use wmux_core::{
    pasted_image, process, remote_probe,
    ssh_command::{resolve_ssh_command, SshCommand},
    tmux_remote,
    tmux_spawn::build_tmux_attach_argv,
};

#[derive(Parser)]
#[command(name = "wmux-server")]
struct Args {
    /// Address to bind, e.g. 100.64.0.3:8787. Do NOT bind to a public address.
    #[arg(long, default_value = "127.0.0.1:8787")]
    bind: String,
    /// Shared secret. Required on /ws and /download as ?token=.
    #[arg(long)]
    token: String,
    /// Directory of built frontend assets to serve (vite `dist/`).
    #[arg(long = "static", default_value = "./dist")]
    static_dir: PathBuf,
    /// Filesystem root that readDir/download are confined to. Defaults to $HOME.
    #[arg(long)]
    root: Option<PathBuf>,
}

#[derive(Clone)]
struct AppState {
    token: Arc<String>,
    root: Arc<PathBuf>,
}

#[tokio::main]
async fn main() {
    let args = Args::parse();

    let root_arg = args.root.unwrap_or_else(default_root);
    let root = std::fs::canonicalize(&root_arg)
        .unwrap_or_else(|e| panic!("--root {:?} is not accessible: {e}", root_arg));
    let root_display = root.display().to_string();

    let state = AppState {
        token: Arc::new(args.token),
        root: Arc::new(root),
    };

    let app = Router::new()
        .route("/ws", any(ws_handler))
        .route("/download", get(download))
        .fallback_service(ServeDir::new(&args.static_dir).append_index_html_on_directories(true))
        .with_state(state);

    let addr: SocketAddr = args.bind.parse().expect("--bind must be host:port");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("cannot bind {addr}: {e}"));
    eprintln!("wmux-server listening on http://{addr}  (root={root_display})");
    axum::serve(listener, app).await.expect("server error");
}

fn default_root() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// This server host's name, shown as the "local" host label in the browser UI.
fn server_hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok().filter(|s| !s.is_empty()))
        .or_else(|| std::env::var("COMPUTERNAME").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "server".to_string())
}

fn token_ok(q: &HashMap<String, String>, st: &AppState) -> bool {
    q.get("token").map(String::as_str) == Some(st.token.as_str())
}

/// Resolve a client-supplied path and confine it to `root`. Empty -> root.
fn resolve_in_root(root: &Path, p: &str) -> Result<PathBuf, String> {
    let candidate = if p.is_empty() {
        root.to_path_buf()
    } else {
        let pb = PathBuf::from(p);
        if pb.is_absolute() {
            pb
        } else {
            root.join(pb)
        }
    };
    let canon = std::fs::canonicalize(&candidate).map_err(|e| format!("{p}: {e}"))?;
    if !canon.starts_with(root) {
        return Err(format!("{p}: outside root"));
    }
    Ok(canon)
}

// ---- WebSocket protocol -----------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ClientMsg {
    Spawn {
        id: i64,
        rows: u16,
        cols: u16,
        command: Option<String>,
        command_argv: Option<Vec<String>>,
        ssh_connection: Option<SshCommand>,
        tmux_session: Option<String>,
        cwd: Option<String>,
        workspace_id: Option<String>,
        surface_id: Option<String>,
        enable_agent_session_reporting: Option<bool>,
    },
    Write {
        id: i64,
        data: String,
    },
    Resize {
        id: i64,
        rows: u16,
        cols: u16,
    },
    Kill {
        id: i64,
    },
    ReadDir {
        req_id: i64,
        path: String,
    },
    Invoke {
        req_id: i64,
        command: String,
        args: Value,
    },
}

#[derive(Serialize, Debug)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum ServerMsg {
    Spawned {
        id: i64,
        pty_id: u32,
    },
    Output {
        pty_id: u32,
        data: String,
        surface_id: Option<String>,
    },
    Exit {
        pty_id: u32,
        code: Option<i32>,
        surface_id: Option<String>,
    },
    Dir {
        req_id: i64,
        path: String,
        entries: Vec<DirEntry>,
    },
    InvokeResult {
        req_id: i64,
        value: Value,
    },
    Event {
        event: String,
        payload: Value,
    },
    Error {
        req_id: Option<i64>,
        message: String,
    },
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    name: String,
    is_dir: bool,
    size: u64,
    mtime: Option<u64>,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<HashMap<String, String>>,
    State(st): State<AppState>,
) -> Response {
    if !token_ok(&q, &st) {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, st))
}

async fn handle_socket(socket: WebSocket, st: AppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<ServerMsg>();
    let ptys = ServerPtyManager::new(out_tx.clone(), st.root.clone());
    let monitors = ServerMonitorManager::new(out_tx.clone());

    let writer = tokio::spawn(async move {
        while let Some(reply) = out_rx.recv().await {
            let json = serde_json::to_string(&reply).unwrap_or_else(|_| "{}".into());
            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_rx.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };

        match serde_json::from_str::<ClientMsg>(&text) {
            Ok(ClientMsg::ReadDir { req_id, path }) => {
                send_msg(&out_tx, read_dir_reply(&st.root, req_id, &path));
            }
            Ok(ClientMsg::Spawn {
                id,
                rows,
                cols,
                command,
                command_argv,
                ssh_connection,
                tmux_session,
                cwd,
                workspace_id,
                surface_id,
                enable_agent_session_reporting,
            }) => {
                if let Err(message) = ptys.spawn(
                    id,
                    rows,
                    cols,
                    command,
                    command_argv,
                    ssh_connection,
                    tmux_session,
                    cwd,
                    workspace_id,
                    surface_id,
                    enable_agent_session_reporting.unwrap_or(false),
                ) {
                    send_msg(
                        &out_tx,
                        ServerMsg::Error {
                            req_id: Some(id),
                            message,
                        },
                    );
                }
            }
            Ok(ClientMsg::Write { id, data }) => {
                if let Err(message) = ptys.write(id, &data) {
                    send_msg(
                        &out_tx,
                        ServerMsg::Error {
                            req_id: Some(id),
                            message,
                        },
                    );
                }
            }
            Ok(ClientMsg::Resize { id, rows, cols }) => {
                if let Err(message) = ptys.resize(id, rows, cols) {
                    send_msg(
                        &out_tx,
                        ServerMsg::Error {
                            req_id: Some(id),
                            message,
                        },
                    );
                }
            }
            Ok(ClientMsg::Kill { id }) => {
                if let Err(message) = ptys.kill(id) {
                    send_msg(
                        &out_tx,
                        ServerMsg::Error {
                            req_id: Some(id),
                            message,
                        },
                    );
                }
            }
            Ok(ClientMsg::Invoke {
                req_id,
                command,
                args,
            }) => {
                send_msg(
                    &out_tx,
                    handle_invoke(req_id, command, args, &ptys, &monitors).await,
                );
            }
            Err(e) => {
                send_msg(
                    &out_tx,
                    ServerMsg::Error {
                        req_id: None,
                        message: format!("bad message: {e}"),
                    },
                );
            }
        };
    }

    drop(ptys);
    drop(out_tx);
    let _ = writer.await;
}

fn send_msg(tx: &mpsc::UnboundedSender<ServerMsg>, msg: ServerMsg) {
    let _ = tx.send(msg);
}

// ---- Invoke RPC -------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshArgs {
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCliArgs {
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
    names: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TmuxSwitchArgs {
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
    wrapper_session: String,
    target_session: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TmuxNewArgs {
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TmuxKillArgs {
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
    session: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartMonitorArgs {
    monitor_id: String,
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopMonitorArgs {
    monitor_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestSessionContentArgs {
    monitor_id: Option<String>,
    project: String,
    session_id: String,
    request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveImageArgs {
    image_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushImageArgs {
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
    image_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PtyIdArgs {
    id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMetadataArgs {
    id: i64,
    cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentProcessArgs {
    id: i64,
    agent: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfoArgs {
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortsArgs {
    pid: u32,
}

async fn handle_invoke(
    req_id: i64,
    command: String,
    args: Value,
    ptys: &ServerPtyManager,
    monitors: &ServerMonitorManager,
) -> ServerMsg {
    match command.as_str() {
        "get_server_info" => ServerMsg::InvokeResult {
            req_id,
            value: serde_json::json!({
                "hostname": server_hostname(),
                "home": std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default(),
                "user": std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).unwrap_or_default(),
            }),
        },
        "check_remote_tmux" => match ssh_from_value::<SshArgs>(args) {
            Ok(ssh) => {
                blocking_invoke(req_id, move || Ok(remote_probe::check_remote_tmux(&ssh))).await
            }
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "check_remote_clis" => match parse_args::<RemoteCliArgs>(args).and_then(|parsed| {
            ssh_from_parts(parsed.ssh_command, parsed.ssh_connection).map(|ssh| (ssh, parsed.names))
        }) {
            Ok((ssh, names)) => {
                blocking_invoke(req_id, move || {
                    remote_probe::check_remote_clis(&ssh, &names)
                })
                .await
            }
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "tmux_list_sessions" => match ssh_from_value::<SshArgs>(args) {
            Ok(ssh) => blocking_invoke(req_id, move || tmux_remote::list_sessions(&ssh)).await,
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "tmux_switch_client" => match parse_args::<TmuxSwitchArgs>(args).and_then(|parsed| {
            ssh_from_parts(parsed.ssh_command, parsed.ssh_connection)
                .map(|ssh| (ssh, parsed.wrapper_session, parsed.target_session))
        }) {
            Ok((ssh, wrapper_session, target_session)) => {
                blocking_invoke(req_id, move || {
                    tmux_remote::switch_client(&ssh, &wrapper_session, &target_session)
                })
                .await
            }
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "tmux_new_session" => match parse_args::<TmuxNewArgs>(args).and_then(|parsed| {
            ssh_from_parts(parsed.ssh_command, parsed.ssh_connection).map(|ssh| (ssh, parsed.name))
        }) {
            Ok((ssh, name)) => {
                blocking_invoke(req_id, move || {
                    tmux_remote::new_session(&ssh, name.as_deref())
                })
                .await
            }
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "tmux_kill_session" => match parse_args::<TmuxKillArgs>(args).and_then(|parsed| {
            ssh_from_parts(parsed.ssh_command, parsed.ssh_connection)
                .map(|ssh| (ssh, parsed.session))
        }) {
            Ok((ssh, session)) => {
                blocking_invoke(req_id, move || tmux_remote::kill_session(&ssh, &session)).await
            }
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "start_monitor" => match parse_args::<StartMonitorArgs>(args).and_then(|parsed| {
            ssh_from_parts(parsed.ssh_command, parsed.ssh_connection)
                .map(|ssh| (parsed.monitor_id, ssh))
        }) {
            Ok((monitor_id, ssh)) => {
                monitors.start(monitor_id, ssh);
                ServerMsg::InvokeResult {
                    req_id,
                    value: Value::Null,
                }
            }
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "stop_monitor" => match parse_args::<StopMonitorArgs>(args) {
            Ok(parsed) => {
                monitors.stop(&parsed.monitor_id);
                ServerMsg::InvokeResult {
                    req_id,
                    value: Value::Null,
                }
            }
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "request_session_content" => match parse_args::<RequestSessionContentArgs>(args) {
            Ok(parsed) => match monitors.request_session_content(
                parsed.monitor_id.as_deref(),
                parsed.project,
                parsed.session_id,
                parsed.request_id,
            ) {
                Ok(()) => ServerMsg::InvokeResult {
                    req_id,
                    value: Value::Null,
                },
                Err(message) => ServerMsg::Error {
                    req_id: Some(req_id),
                    message,
                },
            },
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "save_image_locally" => match parse_args::<SaveImageArgs>(args) {
            Ok(parsed) => {
                blocking_invoke(req_id, move || {
                    pasted_image::save_image_locally_sync(&parsed.image_base64)
                })
                .await
            }
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "push_image_to_remote" => match parse_args::<PushImageArgs>(args).and_then(|parsed| {
            ssh_from_parts(parsed.ssh_command, parsed.ssh_connection)
                .map(|ssh| (ssh, parsed.image_base64))
        }) {
            Ok((ssh, image_base64)) => {
                blocking_invoke(req_id, move || {
                    pasted_image::push_image_to_remote_sync(&ssh, &image_base64)
                })
                .await
            }
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "get_pty_pid" => match parse_args::<PtyIdArgs>(args) {
            Ok(parsed) => match ptys.get_child_pid(parsed.id) {
                Ok(value) => match serde_json::to_value(value) {
                    Ok(value) => ServerMsg::InvokeResult { req_id, value },
                    Err(e) => ServerMsg::Error {
                        req_id: Some(req_id),
                        message: format!("invoke serialization error: {e}"),
                    },
                },
                Err(message) => ServerMsg::Error {
                    req_id: Some(req_id),
                    message,
                },
            },
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "get_workspace_info" => match parse_args::<WorkspaceInfoArgs>(args) {
            Ok(parsed) => {
                blocking_invoke(req_id, move || {
                    Ok(process::gather_workspace_info(&parsed.cwd))
                })
                .await
            }
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "get_ports" => match parse_args::<PortsArgs>(args) {
            Ok(parsed) => {
                blocking_invoke(req_id, move || Ok(process::get_listening_ports(parsed.pid))).await
            }
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "get_shell_ctx" => match parse_args::<PtyIdArgs>(args) {
            Ok(parsed) => match ptys.get_child_pid(parsed.id) {
                Ok(Some(pid)) => {
                    blocking_invoke(req_id, move || Ok(process::get_shell_context(pid))).await
                }
                Ok(None) => match serde_json::to_value(process::ShellContext::default()) {
                    Ok(value) => ServerMsg::InvokeResult { req_id, value },
                    Err(e) => ServerMsg::Error {
                        req_id: Some(req_id),
                        message: format!("invoke serialization error: {e}"),
                    },
                },
                Err(message) => ServerMsg::Error {
                    req_id: Some(req_id),
                    message,
                },
            },
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "get_session_metadata" => match parse_args::<SessionMetadataArgs>(args) {
            Ok(parsed) => match ptys.get_child_pid(parsed.id) {
                Ok(Some(pid)) => {
                    let cwd = parsed
                        .cwd
                        .or_else(|| ptys.get_spawn_cwd(parsed.id).ok().flatten());
                    blocking_invoke(req_id, move || {
                        Ok(process::collect_session_metadata(pid, cwd))
                    })
                    .await
                }
                Ok(None) => match serde_json::to_value(process::SessionMetadata::default()) {
                    Ok(value) => ServerMsg::InvokeResult { req_id, value },
                    Err(e) => ServerMsg::Error {
                        req_id: Some(req_id),
                        message: format!("invoke serialization error: {e}"),
                    },
                },
                Err(message) => ServerMsg::Error {
                    req_id: Some(req_id),
                    message,
                },
            },
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        "pty_has_agent_process" => match parse_args::<AgentProcessArgs>(args) {
            Ok(parsed) => match ptys.get_child_pid(parsed.id) {
                Ok(Some(pid)) => {
                    blocking_invoke(req_id, move || {
                        Ok(process::process_tree_contains_agent(pid, &parsed.agent))
                    })
                    .await
                }
                Ok(None) => match serde_json::to_value(false) {
                    Ok(value) => ServerMsg::InvokeResult { req_id, value },
                    Err(e) => ServerMsg::Error {
                        req_id: Some(req_id),
                        message: format!("invoke serialization error: {e}"),
                    },
                },
                Err(message) => ServerMsg::Error {
                    req_id: Some(req_id),
                    message,
                },
            },
            Err(message) => ServerMsg::Error {
                req_id: Some(req_id),
                message,
            },
        },
        _ => ServerMsg::Error {
            req_id: Some(req_id),
            message: format!("{command} is not implemented by wmux-server"),
        },
    }
}

fn parse_args<T: DeserializeOwned>(args: Value) -> Result<T, String> {
    serde_json::from_value(args).map_err(|e| format!("bad invoke args: {e}"))
}

fn ssh_from_value<T>(args: Value) -> Result<SshCommand, String>
where
    T: DeserializeOwned + IntoSshParts,
{
    let parsed = parse_args::<T>(args)?;
    let (ssh_command, ssh_connection) = parsed.into_ssh_parts();
    ssh_from_parts(ssh_command, ssh_connection)
}

trait IntoSshParts {
    fn into_ssh_parts(self) -> (Option<String>, Option<SshCommand>);
}

impl IntoSshParts for SshArgs {
    fn into_ssh_parts(self) -> (Option<String>, Option<SshCommand>) {
        (self.ssh_command, self.ssh_connection)
    }
}

fn ssh_from_parts(
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
) -> Result<SshCommand, String> {
    resolve_ssh_command(ssh_command.as_deref(), ssh_connection)
        .ok_or_else(|| "Invalid SSH command".to_string())
}

async fn blocking_invoke<T, F>(req_id: i64, work: F) -> ServerMsg
where
    T: Serialize + Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(value)) => match serde_json::to_value(value) {
            Ok(value) => ServerMsg::InvokeResult { req_id, value },
            Err(e) => ServerMsg::Error {
                req_id: Some(req_id),
                message: format!("invoke serialization error: {e}"),
            },
        },
        Ok(Err(message)) => ServerMsg::Error {
            req_id: Some(req_id),
            message,
        },
        Err(e) => ServerMsg::Error {
            req_id: Some(req_id),
            message: format!("invoke task error: {e}"),
        },
    }
}

// ---- PTY --------------------------------------------------------------------

struct ServerPtyInstance {
    writer: Box<dyn std::io::Write + Send>,
    _master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    child_pid: Option<u32>,
    cwd: Option<String>,
    agent_grants: AgentSessionGrants,
    agent_session_grant: Option<AgentSessionGrant>,
}

impl Drop for ServerPtyInstance {
    fn drop(&mut self) {
        let _ = self.killer.kill();
        if let Some(grant) = &self.agent_session_grant {
            remove_agent_session_grant(&self.agent_grants, grant);
        }
    }
}

struct ServerPtyManager {
    instances: Mutex<HashMap<u32, ServerPtyInstance>>,
    next_id: Mutex<u32>,
    tx: mpsc::UnboundedSender<ServerMsg>,
    root: Arc<PathBuf>,
    agent_grants: AgentSessionGrants,
    agent_ipc: Option<ServerAgentIpc>,
}

impl ServerPtyManager {
    fn new(tx: mpsc::UnboundedSender<ServerMsg>, root: Arc<PathBuf>) -> Self {
        let agent_grants = AgentSessionGrants::default();
        let agent_ipc = ServerAgentIpc::start(tx.clone(), agent_grants.clone()).ok();
        Self {
            instances: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
            tx,
            root,
            agent_grants,
            agent_ipc,
        }
    }

    fn spawn(
        &self,
        client_id: i64,
        rows: u16,
        cols: u16,
        command: Option<String>,
        command_argv: Option<Vec<String>>,
        ssh_connection: Option<SshCommand>,
        tmux_session: Option<String>,
        cwd: Option<String>,
        workspace_id: Option<String>,
        surface_id: Option<String>,
        enable_agent_session_reporting: bool,
    ) -> Result<(), String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to open PTY: {e}"))?;

        let command_argv = match tmux_session {
            Some(session_name) => Some(build_tmux_attach_argv(
                command.as_deref(),
                ssh_connection,
                &session_name,
            )?),
            None => command_argv,
        };
        let command = if command_argv.is_some() {
            None
        } else {
            command
        };
        let mut cmd = command_builder(command, command_argv)?;
        cmd.env("TERM", "xterm-256color");
        let cwd = match cwd {
            Some(path) => resolve_in_root(&self.root, &path)?,
            None => self.root.as_ref().clone(),
        };
        let child_cwd = child_process_cwd(&cwd);
        let instance_cwd = child_cwd.to_string_lossy().into_owned();
        cmd.cwd(child_cwd.as_os_str());
        let agent_session_grant = build_agent_session_grant(
            enable_agent_session_reporting,
            workspace_id.as_deref(),
            surface_id.as_deref(),
        )?;
        let mut agent_session_guard =
            register_agent_session_grant(&self.agent_grants, agent_session_grant.clone());
        apply_wmux_env(
            &mut cmd,
            workspace_id.as_deref(),
            surface_id.as_deref(),
            agent_session_grant
                .as_ref()
                .map(|grant| grant.token.as_str()),
            self.agent_ipc
                .as_ref()
                .and_then(ServerAgentIpc::socket_path),
        );

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn shell: {e}"))?;
        let killer = child.clone_killer();
        let child_pid = child.process_id();

        let id = {
            let mut next = self.next_id.lock().unwrap();
            let id = *next;
            *next += 1;
            id
        };

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("failed to clone reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("failed to take writer: {e}"))?;
        let surface_id_for_events = surface_id.clone();

        self.instances.lock().unwrap().insert(
            id,
            ServerPtyInstance {
                writer,
                _master: pair.master,
                killer,
                child_pid,
                cwd: Some(instance_cwd),
                agent_grants: self.agent_grants.clone(),
                agent_session_grant,
            },
        );
        agent_session_guard.finish();

        send_msg(
            &self.tx,
            ServerMsg::Spawned {
                id: client_id,
                pty_id: id,
            },
        );

        let output_tx = self.tx.clone();
        let output_surface_id = surface_id_for_events.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => send_msg(
                        &output_tx,
                        ServerMsg::Output {
                            pty_id: id,
                            data: String::from_utf8_lossy(&buf[..n]).into_owned(),
                            surface_id: output_surface_id.clone(),
                        },
                    ),
                    Err(_) => break,
                }
            }
            send_msg(
                &output_tx,
                ServerMsg::Exit {
                    pty_id: id,
                    code: None,
                    surface_id: output_surface_id,
                },
            );
        });

        let exit_tx = self.tx.clone();
        let exit_surface_id = surface_id_for_events;
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code() as i32);
            send_msg(
                &exit_tx,
                ServerMsg::Exit {
                    pty_id: id,
                    code,
                    surface_id: exit_surface_id,
                },
            );
        });

        Ok(())
    }

    fn write(&self, id: i64, data: &str) -> Result<(), String> {
        let id = checked_pty_id(id)?;
        let mut instances = self.instances.lock().unwrap();
        let instance = instances
            .get_mut(&id)
            .ok_or_else(|| format!("PTY {id} not found"))?;
        instance
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("write error: {e}"))?;
        instance
            .writer
            .flush()
            .map_err(|e| format!("flush error: {e}"))?;
        Ok(())
    }

    fn resize(&self, id: i64, rows: u16, cols: u16) -> Result<(), String> {
        let id = checked_pty_id(id)?;
        let instances = self.instances.lock().unwrap();
        let instance = instances
            .get(&id)
            .ok_or_else(|| format!("PTY {id} not found"))?;
        instance
            ._master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize error: {e}"))?;
        Ok(())
    }

    fn kill(&self, id: i64) -> Result<(), String> {
        let id = checked_pty_id(id)?;
        self.instances
            .lock()
            .unwrap()
            .remove(&id)
            .ok_or_else(|| format!("PTY {id} not found"))?;
        Ok(())
    }

    fn get_child_pid(&self, id: i64) -> Result<Option<u32>, String> {
        let id = checked_pty_id(id)?;
        Ok(self
            .instances
            .lock()
            .unwrap()
            .get(&id)
            .and_then(|instance| instance.child_pid))
    }

    fn get_spawn_cwd(&self, id: i64) -> Result<Option<String>, String> {
        let id = checked_pty_id(id)?;
        Ok(self
            .instances
            .lock()
            .unwrap()
            .get(&id)
            .and_then(|instance| instance.cwd.clone()))
    }
}

fn build_agent_session_grant(
    enable: bool,
    workspace_id: Option<&str>,
    surface_id: Option<&str>,
) -> Result<Option<AgentSessionGrant>, String> {
    if !enable {
        return Ok(None);
    }
    let Some(workspace_id) = workspace_id.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let Some(surface_id) = surface_id.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    Ok(Some(AgentSessionGrant {
        workspace_id: workspace_id.to_string(),
        surface_id: surface_id.to_string(),
        token: generate_agent_session_token()?,
    }))
}

fn generate_agent_session_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("random token error: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn register_agent_session_grant(
    grants: &AgentSessionGrants,
    grant: Option<AgentSessionGrant>,
) -> AgentSessionGrantGuard {
    if let Some(grant) = grant {
        grants.lock().push(grant.clone());
        AgentSessionGrantGuard {
            grants: grants.clone(),
            grant: Some(grant),
        }
    } else {
        AgentSessionGrantGuard {
            grants: grants.clone(),
            grant: None,
        }
    }
}

fn remove_agent_session_grant(grants: &AgentSessionGrants, grant: &AgentSessionGrant) {
    grants.lock().retain(|candidate| candidate != grant);
}

struct AgentSessionGrantGuard {
    grants: AgentSessionGrants,
    grant: Option<AgentSessionGrant>,
}

impl AgentSessionGrantGuard {
    fn finish(&mut self) {
        self.grant = None;
    }
}

impl Drop for AgentSessionGrantGuard {
    fn drop(&mut self) {
        if let Some(grant) = &self.grant {
            remove_agent_session_grant(&self.grants, grant);
        }
    }
}

fn checked_pty_id(id: i64) -> Result<u32, String> {
    u32::try_from(id).map_err(|_| format!("invalid PTY id {id}"))
}

fn child_process_cwd(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(raw) = path.to_str() {
            if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
                return PathBuf::from(format!(r"\\{rest}"));
            }
            if let Some(rest) = raw.strip_prefix(r"\\?\") {
                return PathBuf::from(rest);
            }
        }
    }
    path.to_path_buf()
}

fn command_builder(
    command: Option<String>,
    command_argv: Option<Vec<String>>,
) -> Result<CommandBuilder, String> {
    if let Some(argv) = command_argv.filter(|argv| !argv.is_empty()) {
        let mut args = argv.into_iter();
        let program = args
            .next()
            .ok_or_else(|| "commandArgv must include a program".to_string())?;
        let mut cmd = CommandBuilder::new(program);
        cmd.args(args);
        return Ok(cmd);
    }

    let shell = default_shell();
    let mut cmd = CommandBuilder::new(shell.program);
    if let Some(command) = command.filter(|value| !value.trim().is_empty()) {
        cmd.args(&shell.command_args);
        cmd.arg(command);
    } else {
        cmd.args(&shell.interactive_args);
    }
    Ok(cmd)
}

fn apply_wmux_env(
    cmd: &mut CommandBuilder,
    workspace_id: Option<&str>,
    surface_id: Option<&str>,
    agent_session_token: Option<&str>,
    socket_path: Option<&Path>,
) {
    if let Some(workspace_id) = workspace_id.filter(|value| !value.is_empty()) {
        cmd.env("WMUX_WORKSPACE_ID", workspace_id);
    }
    if let Some(surface_id) = surface_id.filter(|value| !value.is_empty()) {
        cmd.env("WMUX_SURFACE_ID", surface_id);
    }
    if let Some(agent_session_token) = agent_session_token.filter(|value| !value.is_empty()) {
        cmd.env("WMUX_AGENT_SESSION_TOKEN", agent_session_token);
    }
    if let Some(socket_path) = socket_path {
        cmd.env("WMUX_SOCKET_PATH", socket_path.as_os_str());
    }
    if let Some(cli_path) =
        std::env::var_os("WMUX_BUNDLED_CLI_PATH").filter(|value| !value.is_empty())
    {
        cmd.env("WMUX_BUNDLED_CLI_PATH", cli_path);
    }
}

struct ShellSpec {
    program: String,
    interactive_args: Vec<String>,
    command_args: Vec<String>,
}

fn default_shell() -> ShellSpec {
    if cfg!(windows) {
        let program = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        return ShellSpec {
            program,
            interactive_args: vec![],
            command_args: vec!["/C".to_string()],
        };
    }

    ShellSpec {
        program: std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()),
        interactive_args: vec!["-l".to_string()],
        command_args: vec!["-lc".to_string()],
    }
}

fn read_dir_reply(root: &Path, req_id: i64, path: &str) -> ServerMsg {
    let dir = match resolve_in_root(root, path) {
        Ok(d) => d,
        Err(message) => {
            return ServerMsg::Error {
                req_id: Some(req_id),
                message,
            }
        }
    };
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) => {
            return ServerMsg::Error {
                req_id: Some(req_id),
                message: format!("{e}"),
            }
        }
    };
    let mut entries: Vec<DirEntry> = read
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let meta = e.metadata().ok()?;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            Some(DirEntry {
                name,
                is_dir: meta.is_dir(),
                size: meta.len(),
                mtime,
            })
        })
        .collect();
    // Directories first, then case-insensitive name.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    ServerMsg::Dir {
        req_id,
        path: dir.to_string_lossy().into_owned(),
        entries,
    }
}

// ---- Download ---------------------------------------------------------------

async fn download(
    Query(q): Query<HashMap<String, String>>,
    State(st): State<AppState>,
) -> Response {
    if !token_ok(&q, &st) {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    let path = match q.get("path") {
        Some(p) => p.clone(),
        None => return (StatusCode::BAD_REQUEST, "missing path").into_response(),
    };
    let root = st.root.clone();

    // std::fs + zip are blocking; keep them off the async runtime.
    let result = tokio::task::spawn_blocking(move || build_download(&root, &path)).await;

    match result {
        Ok(Ok((filename, bytes))) => {
            let disposition = format!("attachment; filename=\"{}\"", sanitize_filename(&filename));
            (
                [
                    (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                    (header::CONTENT_DISPOSITION, disposition),
                ],
                bytes,
            )
                .into_response()
        }
        Ok(Err(msg)) => (StatusCode::FORBIDDEN, msg).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")).into_response(),
    }
}

fn build_download(root: &Path, path: &str) -> Result<(String, Vec<u8>), String> {
    let target = resolve_in_root(root, path)?;
    let meta = std::fs::metadata(&target).map_err(|e| format!("{e}"))?;
    let base = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());

    if meta.is_dir() {
        let bytes = zip_dir(&target)?;
        Ok((format!("{base}.zip"), bytes))
    } else {
        let bytes = std::fs::read(&target).map_err(|e| format!("{e}"))?;
        Ok((base, bytes))
    }
}

fn zip_dir(dir: &Path) -> Result<Vec<u8>, String> {
    use zip::write::SimpleFileOptions;
    let mut cursor = std::io::Cursor::new(Vec::new());
    let mut zw = zip::ZipWriter::new(&mut cursor);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for entry in walkdir::WalkDir::new(dir).into_iter().flatten() {
        let p = entry.path();
        let rel = match p.strip_prefix(dir) {
            Ok(r) if !r.as_os_str().is_empty() => r,
            _ => continue,
        };
        let name = rel.to_string_lossy().replace('\\', "/");
        if entry.file_type().is_dir() {
            zw.add_directory(format!("{name}/"), options)
                .map_err(|e| format!("{e}"))?;
        } else if entry.file_type().is_file() {
            zw.start_file(name, options).map_err(|e| format!("{e}"))?;
            let data = std::fs::read(p).map_err(|e| format!("{e}"))?;
            zw.write_all(&data).map_err(|e| format!("{e}"))?;
        }
    }
    zw.finish().map_err(|e| format!("{e}"))?;
    Ok(cursor.into_inner())
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c == '"' || c == '\\' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        let mut dir = std::env::temp_dir();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        dir.push(format!("wmux-server-test-{nonce}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    #[test]
    fn resolve_in_root_accepts_empty_and_relative_paths() {
        let root = temp_root();
        let child = root.join("child");
        std::fs::create_dir_all(&child).unwrap();

        assert_eq!(resolve_in_root(&root, "").unwrap(), root);
        assert_eq!(resolve_in_root(&root, "child").unwrap(), child);
    }

    #[test]
    fn resolve_in_root_rejects_parent_escape() {
        let root = temp_root();
        let outside = root.parent().unwrap().to_path_buf();
        let escaped = root.join("..");

        assert_eq!(
            resolve_in_root(&root, &escaped.to_string_lossy()).unwrap_err(),
            format!("{}: outside root", escaped.to_string_lossy())
        );
        assert_eq!(
            resolve_in_root(&root, &outside.to_string_lossy()).unwrap_err(),
            format!("{}: outside root", outside.to_string_lossy())
        );
    }

    #[test]
    fn sanitize_filename_replaces_header_breaking_chars() {
        assert_eq!(sanitize_filename("a\"b\\c\n"), "a_b_c_");
    }

    #[test]
    fn child_process_cwd_removes_windows_verbatim_prefix() {
        let path = PathBuf::from(r"\\?\C:\Users\one\Projects\wmux");
        let cwd = child_process_cwd(&path);
        if cfg!(windows) {
            assert_eq!(cwd, PathBuf::from(r"C:\Users\one\Projects\wmux"));
        } else {
            assert_eq!(cwd, path);
        }
    }
}
