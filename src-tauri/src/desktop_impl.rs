mod browser;
mod control;
mod desktop_agent;
mod file_tree;
mod monitor;
mod pasted_image;
mod platform;
mod pty;
mod remote_control;
mod remote_monitor;
mod ssh_command;
mod tmux_cc;
mod tmux_remote;

use monitor::MonitorManager;
use desktop_agent::{
    check_local_clis_sync, desktop_agent_close, desktop_agent_open, desktop_agent_write,
    desktop_claude_session, desktop_claude_sessions, desktop_session_goal_delete,
    desktop_session_goal_set, desktop_session_goals, DesktopAgentManager,
};
use pasted_image::{push_image_to_remote_sync, save_image_locally_sync};
use platform::command::silent_command;
use platform::process::{
    collect_session_metadata, gather_workspace_info, get_listening_ports, get_shell_context,
    process_tree_contains_agent, SessionMetadata, ShellContext, WorkspaceInfo,
};
use pty::{PtyEvent, PtyEventChannel, PtyManager, MuxpitPtyContext};
use ssh_command::{quote_posix_shell_arg, resolve_ssh_command, SshCommand};
use std::collections::HashMap;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

#[tauri::command]
fn spawn_pty(
    app: AppHandle,
    state: State<'_, PtyManager>,
    rows: u16,
    cols: u16,
    command: Option<String>,
    command_argv: Option<Vec<String>>,
    cwd: Option<String>,
    enable_cwd_reporting: bool,
    enable_agent_session_reporting: bool,
    workspace_id: Option<String>,
    surface_id: Option<String>,
) -> Result<u32, String> {
    state.spawn(
        app,
        rows,
        cols,
        command,
        command_argv,
        cwd,
        enable_cwd_reporting,
        MuxpitPtyContext {
            workspace_id,
            surface_id,
            enable_agent_session_reporting,
        },
    )
}

#[tauri::command]
fn spawn_pty_tmux_cc(
    app: AppHandle,
    state: State<'_, PtyManager>,
    rows: u16,
    cols: u16,
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
    session_name: String,
    workspace_id: Option<String>,
    surface_id: Option<String>,
) -> Result<u32, String> {
    state.spawn_tmux_cc(
        app,
        rows,
        cols,
        ssh_command,
        ssh_connection,
        session_name,
        MuxpitPtyContext {
            workspace_id,
            surface_id,
            enable_agent_session_reporting: false,
        },
    )
}

#[tauri::command]
fn subscribe_pty_events(state: State<'_, PtyEventChannel>, channel: Channel<PtyEvent>) {
    state.set(channel);
}

#[tauri::command]
fn write_pty(state: State<'_, PtyManager>, id: u32, data: String) -> Result<(), String> {
    state.write(id, &data)
}

#[tauri::command]
fn resize_pty(state: State<'_, PtyManager>, id: u32, rows: u16, cols: u16) -> Result<(), String> {
    state.resize(id, rows, cols)
}

#[tauri::command]
fn kill_pty(state: State<'_, PtyManager>, id: u32) -> Result<(), String> {
    state.kill(id)
}

#[tauri::command]
async fn get_workspace_info(cwd: String) -> Result<WorkspaceInfo, String> {
    tauri::async_runtime::spawn_blocking(move || gather_workspace_info(&cwd))
        .await
        .map_err(|e| format!("Task join error: {e}"))
}

#[tauri::command]
async fn get_ports(pid: u32) -> Result<Vec<u16>, String> {
    tauri::async_runtime::spawn_blocking(move || get_listening_ports(pid))
        .await
        .map_err(|e| format!("Task join error: {e}"))
}

#[tauri::command]
fn get_pty_pid(state: State<'_, PtyManager>, id: u32) -> Result<Option<u32>, String> {
    state.get_child_pid(id)
}

#[tauri::command]
async fn get_shell_ctx(state: State<'_, PtyManager>, id: u32) -> Result<ShellContext, String> {
    let pid = state.get_child_pid(id)?;
    match pid {
        Some(p) => tauri::async_runtime::spawn_blocking(move || get_shell_context(p))
            .await
            .map_err(|e| format!("Task join error: {e}")),
        None => Ok(ShellContext::default()),
    }
}

#[tauri::command]
async fn get_session_metadata(
    state: State<'_, PtyManager>,
    id: u32,
    cwd: Option<String>,
) -> Result<SessionMetadata, String> {
    let pid = state.get_child_pid(id)?;
    match pid {
        Some(p) => tauri::async_runtime::spawn_blocking(move || collect_session_metadata(p, cwd))
            .await
            .map_err(|e| format!("Task join error: {e}")),
        None => Ok(SessionMetadata::default()),
    }
}

#[tauri::command]
async fn pty_has_agent_process(
    state: State<'_, PtyManager>,
    id: u32,
    agent: String,
) -> Result<bool, String> {
    let pid = state.get_child_pid(id)?;
    match pid {
        Some(p) => {
            tauri::async_runtime::spawn_blocking(move || process_tree_contains_agent(p, &agent))
                .await
                .map_err(|e| format!("Task join error: {e}"))
        }
        None => Ok(false),
    }
}

#[tauri::command]
async fn list_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(platform::fonts::list_fonts_sync)
        .await
        .map_err(|e| format!("Task join error: {e}"))
}

#[tauri::command]
async fn read_dir(path: Option<String>) -> Result<file_tree::DirListing, String> {
    tauri::async_runtime::spawn_blocking(move || file_tree::list_local_dir(path.as_deref()))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn remote_read_dir(
    path: String,
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
) -> Result<file_tree::DirListing, String> {
    let ssh = resolve_ssh_command(ssh_command.as_deref(), ssh_connection)
        .ok_or_else(|| "Invalid SSH command".to_string())?;
    tauri::async_runtime::spawn_blocking(move || file_tree::list_remote_dir(&ssh, &path))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
fn start_monitor(
    app: AppHandle,
    state: State<'_, MonitorManager>,
    monitor_id: String,
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
) -> Result<(), String> {
    let ssh = resolve_ssh_command(ssh_command.as_deref(), ssh_connection)
        .ok_or_else(|| "Invalid SSH command".to_string())?;
    state.start(app, monitor_id, ssh)
}

#[tauri::command]
fn stop_monitor(state: State<'_, MonitorManager>, monitor_id: String) -> Result<(), String> {
    state.stop(&monitor_id)
}

#[tauri::command]
fn request_session_content(
    state: State<'_, MonitorManager>,
    monitor_id: Option<String>,
    project: String,
    session_id: String,
    request_id: String,
) -> Result<(), String> {
    state.request_session_content(monitor_id.as_deref(), project, session_id, request_id)
}

#[tauri::command]
fn resolve_control_request(
    state: State<'_, control::ControlBroker>,
    request_id: String,
    data: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<(), String> {
    state.resolve(&request_id, data, error)
}

#[tauri::command]
async fn check_remote_clis(
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
    names: Vec<String>,
) -> Result<HashMap<String, bool>, String> {
    let ssh = resolve_ssh_command(ssh_command.as_deref(), ssh_connection)
        .ok_or_else(|| "Invalid SSH command".to_string())?;
    tauri::async_runtime::spawn_blocking(move || check_remote_clis_sync(&ssh, &names))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn check_local_clis(names: Vec<String>) -> Result<HashMap<String, bool>, String> {
    tauri::async_runtime::spawn_blocking(move || check_local_clis_sync(&names))
        .await
        .map_err(|e| format!("Task join error: {e}"))
}

/// Returns the remote tmux version (e.g. `"3.4"`) when tmux is found on the
/// target host and can execute `tmux -V`; otherwise `None`.
#[tauri::command]
async fn check_remote_tmux(
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
) -> Result<Option<String>, String> {
    let ssh = resolve_ssh_command(ssh_command.as_deref(), ssh_connection)
        .ok_or_else(|| "Invalid SSH command".to_string())?;
    tauri::async_runtime::spawn_blocking(move || check_remote_tmux_sync(&ssh))
        .await
        .map_err(|e| format!("Task join error: {e}"))
}

fn check_remote_tmux_sync(ssh: &SshCommand) -> Option<String> {
    let mut cmd = silent_command(&ssh.program);
    for opt in &ssh.options {
        cmd.arg(opt);
    }
    cmd.args([
        "-o",
        "ConnectTimeout=3",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
    ]);
    cmd.arg(&ssh.target);
    cmd.arg("tmux -V 2>/dev/null");

    cmd.stderr(Stdio::null());

    match cmd.output() {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            // Expected format: "tmux 3.4" or "tmux next-3.5" etc.
            stdout
                .split_whitespace()
                .nth(1)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        }
        _ => None,
    }
}

fn check_remote_clis_sync(
    ssh: &SshCommand,
    names: &[String],
) -> Result<HashMap<String, bool>, String> {
    // Result map seeded with `false` for every requested name. Callers always get a
    // complete answer even if SSH fails or some names are filtered out below.
    let mut result: HashMap<String, bool> = names.iter().map(|n| (n.clone(), false)).collect();

    // Drop names that contain anything other than [A-Za-z0-9_-]; we splice them
    // unquoted into the remote shell command, so we refuse to forward characters
    // that could break out of the `for` loop.
    let safe_names: Vec<&str> = names
        .iter()
        .filter(|n| {
            !n.is_empty()
                && n.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
        .map(|n| n.as_str())
        .collect();
    if safe_names.is_empty() {
        return Ok(result);
    }

    let mut cmd = silent_command(&ssh.program);
    for opt in &ssh.options {
        cmd.arg(opt);
    }
    cmd.args([
        "-o",
        "ConnectTimeout=10",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
    ]);
    cmd.arg(&ssh.target);

    // One SSH invocation iterates all candidates and prints the names that resolve.
    // Only ASCII-safe names land unquoted inside the `for` list (filtered above).
    let remote = format!(
        "for n in {}; do command -v \"$n\" >/dev/null 2>&1 && echo \"$n\"; done",
        safe_names.join(" ")
    );
    cmd.arg(login_shell_remote_command(&remote));

    cmd.stderr(Stdio::null());

    let output = cmd
        .output()
        .map_err(|e| format!("failed to spawn ssh: {e}"))?;
    // ssh exits 255 for its own failures (connect/auth/timeout). Surface that as an
    // error so the caller retries instead of caching a false "nothing installed".
    // A successful connection whose remote `for` loop found nothing exits 0/1 and
    // falls through — stdout stays the source of truth.
    if output.status.code() == Some(255) {
        return Err("ssh probe connection failed".into());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let n = line.trim();
        if n.is_empty() {
            continue;
        }
        if let Some(v) = result.get_mut(n) {
            *v = true;
        }
    }
    Ok(result)
}

pub(crate) fn login_shell_remote_command(command: &str) -> String {
    let outer = format!(
        "shell=${{SHELL:-/bin/sh}}; \
         case \"$shell\" in sh|bash|zsh|ksh|dash|*/sh|*/bash|*/zsh|*/ksh|*/dash) muxpit_shell=\"$shell\" ;; *) muxpit_shell=/bin/sh ;; esac; \
         exec \"$muxpit_shell\" -lc {}",
        quote_posix_shell_arg(command)
    );
    format!("/bin/sh -lc {}", quote_posix_shell_arg(&outer))
}

#[cfg(test)]
mod remote_cli_tests {
    use super::*;

    #[test]
    fn remote_cli_probe_uses_configured_login_shell() {
        let command = login_shell_remote_command("command -v claude");

        assert!(command.starts_with("/bin/sh -lc "));
        assert!(command.contains("${SHELL:-/bin/sh}"));
        assert!(command.contains("case \"$shell\" in"));
        assert!(command.contains("*) muxpit_shell=/bin/sh"));
        assert!(command.contains("command -v claude"));
        assert!(!command.contains("bash -lc"));
    }

    #[test]
    fn remote_cli_probe_quotes_inner_command() {
        let command = login_shell_remote_command("printf '%s\\n' ok");

        assert!(command.contains("'\\''%s\\n'\\''"));
    }
}

#[tauri::command]
async fn save_image_locally(image_base64: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || save_image_locally_sync(&image_base64))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn push_image_to_remote(
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
    image_base64: String,
) -> Result<String, String> {
    let ssh = resolve_ssh_command(ssh_command.as_deref(), ssh_connection)
        .ok_or_else(|| "not an ssh pane".to_string())?;
    tauri::async_runtime::spawn_blocking(move || push_image_to_remote_sync(&ssh, &image_base64))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn tmux_list_sessions(
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
) -> Result<Vec<tmux_remote::TmuxSession>, String> {
    let ssh = resolve_ssh_command(ssh_command.as_deref(), ssh_connection)
        .ok_or_else(|| "Invalid SSH command".to_string())?;
    tauri::async_runtime::spawn_blocking(move || tmux_remote::list_sessions(&ssh))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn tmux_active_pane_cwd(
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
    session: String,
) -> Result<Option<String>, String> {
    let ssh = resolve_ssh_command(ssh_command.as_deref(), ssh_connection)
        .ok_or_else(|| "Invalid SSH command".to_string())?;
    tauri::async_runtime::spawn_blocking(move || tmux_remote::active_pane_cwd(&ssh, &session))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn tmux_switch_client(
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
    wrapper_session: String,
    target_session: String,
) -> Result<(), String> {
    let ssh = resolve_ssh_command(ssh_command.as_deref(), ssh_connection)
        .ok_or_else(|| "Invalid SSH command".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        tmux_remote::switch_client(&ssh, &wrapper_session, &target_session)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn tmux_new_session(
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
    name: Option<String>,
) -> Result<String, String> {
    let ssh = resolve_ssh_command(ssh_command.as_deref(), ssh_connection)
        .ok_or_else(|| "Invalid SSH command".to_string())?;
    tauri::async_runtime::spawn_blocking(move || tmux_remote::new_session(&ssh, name.as_deref()))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn tmux_kill_session(
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
    session: String,
) -> Result<(), String> {
    let ssh = resolve_ssh_command(ssh_command.as_deref(), ssh_connection)
        .ok_or_else(|| "Invalid SSH command".to_string())?;
    tauri::async_runtime::spawn_blocking(move || tmux_remote::kill_session(&ssh, &session))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Lightweight snapshot of the frontend's workspaces, pushed from the UI so the
/// CLI (`muxpit-cli ls`) can list them over the IPC pipe. The backend owns no workspace
/// state otherwise; this is a read-through mirror updated on every UI change.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    pub pane_count: u32,
    pub active: bool,
}

#[derive(Default)]
pub struct WorkspaceRegistry(pub std::sync::Mutex<Vec<WorkspaceSummary>>);

#[tauri::command]
fn set_workspace_list(state: State<'_, WorkspaceRegistry>, workspaces: Vec<WorkspaceSummary>) {
    *state.0.lock().unwrap() = workspaces;
}

#[tauri::command]
fn send_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| format!("Notification error: {e}"))
}

#[tauri::command]
fn install_cli_symlink() -> Result<String, String> {
    platform::cli::install_cli_symlink().map(|path| path.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::panic::set_hook(Box::new(|panic_info| {
        log::error!("panic: {panic_info}");
    }));

    tauri::Builder::default()
        .manage(PtyManager::new())
        .manage(PtyEventChannel::default())
        .manage(MonitorManager::new())
        .manage(WorkspaceRegistry::default())
        .manage(control::ControlBroker::default())
        .manage(DesktopAgentManager::default())
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            spawn_pty_tmux_cc,
            subscribe_pty_events,
            write_pty,
            resize_pty,
            kill_pty,
            get_workspace_info,
            get_ports,
            get_pty_pid,
            get_shell_ctx,
            get_session_metadata,
            pty_has_agent_process,
            list_fonts,
            read_dir,
            remote_read_dir,
            check_remote_clis,
            check_local_clis,
            check_remote_tmux,
            desktop_agent_open,
            desktop_agent_write,
            desktop_agent_close,
            desktop_claude_sessions,
            desktop_claude_session,
            desktop_session_goals,
            desktop_session_goal_set,
            desktop_session_goal_delete,
            save_image_locally,
            push_image_to_remote,
            tmux_list_sessions,
            tmux_active_pane_cwd,
            tmux_switch_client,
            tmux_new_session,
            tmux_kill_session,
            send_notification,
            install_cli_symlink,
            set_workspace_list,
            request_session_content,
            resolve_control_request,
            start_monitor,
            stop_monitor,
            browser::browser_create,
            browser::browser_update_bounds,
            browser::browser_set_visible,
            browser::browser_close,
            browser::browser_navigate,
            browser::browser_reload,
            browser::browser_current_url,
            browser::browser_snapshot,
            browser::browser_console_logs,
            browser::browser_screenshot,
        ])
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([Target::new(TargetKind::LogDir {
                    file_name: Some("muxpit".into()),
                })])
                .rotation_strategy(RotationStrategy::KeepSome(8))
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .max_file_size(1_000_000)
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            migrate_legacy_app_dirs(app.handle());
            log::info!(
                "muxpit setup complete version={} debug={} pid={}",
                app.package_info().version,
                cfg!(debug_assertions),
                std::process::id()
            );
            start_heartbeat();
            // Start local IPC server for muxpit-cli and shell hooks.
            platform::ipc::start_ipc_server(app.handle().clone());
            let relay = platform::ipc::start_control_relay(app.handle().clone());
            if let Some(port) = relay.port() {
                log::info!("SSH control relay listening on 127.0.0.1:{port}");
            }
            app.manage(relay);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// One-time carry-over of data written under the pre-rename identifier
// (com.wmux.terminal). Non-overwriting, so it never clobbers muxpit state.
fn migrate_legacy_app_dirs(app: &AppHandle) {
    const LEGACY_IDENTIFIER: &str = "com.wmux.terminal";
    let resolver = app.path();
    let dirs = [
        resolver.app_data_dir(),
        resolver.app_config_dir(),
        resolver.app_local_data_dir(),
    ];
    let mut seen = std::collections::HashSet::new();
    for dir in dirs.into_iter().flatten() {
        if !seen.insert(dir.clone()) {
            continue;
        }
        let Some(parent) = dir.parent() else { continue };
        let legacy = parent.join(LEGACY_IDENTIFIER);
        if !legacy.is_dir() {
            continue;
        }
        match copy_missing(&legacy, &dir) {
            Ok(()) => log::info!("migrated legacy app data from {}", legacy.display()),
            Err(err) => log::warn!(
                "legacy app data migration from {} failed: {err}",
                legacy.display()
            ),
        }
    }
}

fn copy_missing(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_missing(&entry.path(), &target)?;
        } else if file_type.is_file() && !target.exists() {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn start_heartbeat() {
    let started = Instant::now();
    if let Err(err) = std::thread::Builder::new()
        .name("muxpit-heartbeat".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(60));
            log::info!(
                "muxpit heartbeat pid={} uptime_secs={}",
                std::process::id(),
                started.elapsed().as_secs()
            );
        })
    {
        log::warn!("failed to start heartbeat: {err}");
    }
}
