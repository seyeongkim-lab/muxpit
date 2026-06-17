mod ipc;
mod monitor;
mod pty;
mod sysinfo;
mod tmux_cc;
mod tmux_remote;

use monitor::MonitorManager;
use pty::PtyManager;
use std::collections::HashMap;
use std::process::{Command, Stdio};
use sysinfo::{
    gather_workspace_info, get_listening_ports, get_shell_context, ShellContext, WorkspaceInfo,
};
use tauri::{AppHandle, State};

#[tauri::command]
fn spawn_pty(
    app: AppHandle,
    state: State<'_, PtyManager>,
    rows: u16,
    cols: u16,
    command: Option<String>,
) -> Result<u32, String> {
    state.spawn(app, rows, cols, command)
}

#[tauri::command]
fn spawn_pty_tmux_cc(
    app: AppHandle,
    state: State<'_, PtyManager>,
    rows: u16,
    cols: u16,
    ssh_command: String,
    session_name: String,
) -> Result<u32, String> {
    state.spawn_tmux_cc(app, rows, cols, ssh_command, session_name)
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
async fn list_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| list_fonts_sync())
        .await
        .map_err(|e| format!("Task join error: {e}"))
}

#[cfg(windows)]
fn list_fonts_sync() -> Vec<String> {
    let mut cmd = std::process::Command::new("powershell");
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000);
    let output = cmd.args([
            "-NoProfile",
            "-Command",
            r#"[System.Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }"#,
        ])
        .output();

    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        _ => vec![],
    }
}

#[cfg(unix)]
fn list_fonts_sync() -> Vec<String> {
    // fc-list :family outputs one family name per line
    let output = std::process::Command::new("fc-list")
        .args([":family"])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let mut fonts: Vec<String> = String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            fonts.sort();
            fonts.dedup();
            fonts
        }
        _ => vec![],
    }
}

#[tauri::command]
fn start_monitor(
    app: AppHandle,
    state: State<'_, MonitorManager>,
    monitor_id: String,
    ssh_target: String,
) -> Result<(), String> {
    state.start(app, monitor_id, ssh_target)
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
async fn check_remote_clis(
    ssh_command: String,
    names: Vec<String>,
) -> Result<HashMap<String, bool>, String> {
    tauri::async_runtime::spawn_blocking(move || check_remote_clis_sync(&ssh_command, &names))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Returns the remote tmux version (e.g. `"3.4"`) when tmux is found on the
/// target host and can execute `tmux -V`; otherwise `None`.
#[tauri::command]
async fn check_remote_tmux(ssh_command: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || check_remote_tmux_sync(&ssh_command))
        .await
        .map_err(|e| format!("Task join error: {e}"))
}

fn check_remote_tmux_sync(ssh_command: &str) -> Option<String> {
    let (program, options, target) = tmux_remote::parse_ssh_args(ssh_command)?;
    let mut cmd = Command::new(program);
    for opt in &options {
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
    cmd.arg(target);
    cmd.arg("tmux -V 2>/dev/null");

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

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

fn check_remote_clis_sync(ssh_command: &str, names: &[String]) -> Result<HashMap<String, bool>, String> {
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

    // Parse the SSH command: "ssh [-p port] [-i key] user@host"
    let Some((program, options, target)) = tmux_remote::parse_ssh_args(ssh_command) else {
        return Ok(result);
    };

    let mut cmd = Command::new(program);
    for opt in &options {
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
    cmd.arg(target);

    // One SSH invocation iterates all candidates and prints the names that resolve.
    // Outer single-quotes wrap the bash -lc payload; only ASCII-safe names land
    // unquoted inside the `for` list (filtered above).
    let remote = format!(
        "for n in {}; do command -v \"$n\" >/dev/null 2>&1 && echo \"$n\"; done",
        safe_names.join(" ")
    );
    cmd.arg(format!("bash -lc '{remote}'"));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd.stderr(Stdio::null());

    let output = cmd.output().map_err(|e| format!("failed to spawn ssh: {e}"))?;
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

#[tauri::command]
async fn push_image_to_remote(
    ssh_command: String,
    image_base64: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        push_image_to_remote_sync(&ssh_command, &image_base64)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Upload a clipboard image to the pane's SSH host and return the remote path.
/// `ssh_command` may be an AI-pane launcher (`ssh -t ... "bash -lc '...'"`):
/// only `-p`/`-i` option pairs are kept, because `-t` allocates a pty that
/// mangles the binary stdin stream and the trailing remote-command tokens are
/// not ssh options.
fn push_image_to_remote_sync(ssh_command: &str, image_base64: &str) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64)
        .map_err(|e| format!("invalid image data: {e}"))?;

    let (program, options, target) =
        tmux_remote::parse_ssh_args(ssh_command).ok_or_else(|| "not an ssh pane".to_string())?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dir = "$HOME/.wmux/screenshots";
    let file = format!("{dir}/wmux-{stamp}.png");

    let mut cmd = Command::new(program);
    let mut opts = options.iter();
    while let Some(o) = opts.next() {
        if o == "-p" || o == "-i" {
            if let Some(v) = opts.next() {
                cmd.arg(o).arg(v);
            }
        }
    }
    cmd.args([
        "-o",
        "ConnectTimeout=10",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
    ]);
    cmd.arg(target);
    cmd.arg(format!("mkdir -p {dir} && cat > {file} && echo {file}"));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("ssh spawn failed: {e}"))?;
    {
        use std::io::Write as _;
        let mut stdin = child.stdin.take().ok_or("ssh stdin unavailable")?;
        stdin
            .write_all(&bytes)
            .map_err(|e| format!("upload failed: {e}"))?;
        // stdin drops here → EOF → remote `cat` completes
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("ssh failed: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("upload failed: {}", err.trim()));
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        return Err("upload failed: remote returned no path".into());
    }
    Ok(path)
}

#[tauri::command]
async fn tmux_list_sessions(ssh_command: String) -> Result<Vec<tmux_remote::TmuxSession>, String> {
    tauri::async_runtime::spawn_blocking(move || tmux_remote::list_sessions(&ssh_command))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn tmux_switch_client(
    ssh_command: String,
    wrapper_session: String,
    target_session: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        tmux_remote::switch_client(&ssh_command, &wrapper_session, &target_session)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn tmux_new_session(ssh_command: String, name: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tmux_remote::new_session(&ssh_command, name.as_deref())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn tmux_kill_session(ssh_command: String, session: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || tmux_remote::kill_session(&ssh_command, &session))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Lightweight snapshot of the frontend's workspaces, pushed from the UI so the
/// CLI (`wmux ls`) can list them over the IPC pipe. The backend owns no workspace
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyManager::new())
        .manage(MonitorManager::new())
        .manage(WorkspaceRegistry::default())
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            spawn_pty_tmux_cc,
            write_pty,
            resize_pty,
            kill_pty,
            get_workspace_info,
            get_ports,
            get_pty_pid,
            get_shell_ctx,
            list_fonts,
            check_remote_clis,
            check_remote_tmux,
            push_image_to_remote,
            tmux_list_sessions,
            tmux_switch_client,
            tmux_new_session,
            tmux_kill_session,
            send_notification,
            set_workspace_list,
            request_session_content,
            start_monitor,
            stop_monitor,
        ])
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Start Named Pipe IPC server
            ipc::start_ipc_server(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
