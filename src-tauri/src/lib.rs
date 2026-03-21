mod ipc;
mod monitor;
mod pty;
mod sysinfo;

use monitor::MonitorManager;
use pty::PtyManager;
use sysinfo::{gather_workspace_info, get_listening_ports, get_shell_context, ShellContext, WorkspaceInfo};
use tauri::{AppHandle, State};

#[tauri::command]
fn spawn_pty(app: AppHandle, state: State<'_, PtyManager>, rows: u16, cols: u16, command: Option<String>) -> Result<u32, String> {
    state.spawn(app, rows, cols, command)
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

fn list_fonts_sync() -> Vec<String> {
    let mut cmd = std::process::Command::new("powershell");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.args([
            "-NoProfile",
            "-Command",
            r#"[System.Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }"#,
        ])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        }
        _ => vec![],
    }
}

#[tauri::command]
fn start_monitor(app: AppHandle, state: State<'_, MonitorManager>, monitor_id: String, ssh_target: String) -> Result<(), String> {
    state.start(app, monitor_id, ssh_target)
}

#[tauri::command]
fn stop_monitor(state: State<'_, MonitorManager>, monitor_id: String) -> Result<(), String> {
    state.stop(&monitor_id)
}

#[tauri::command]
async fn fetch_claude_session(ssh_target: String, project: String, session_id: String) -> Result<Vec<String>, String> {
    let path = format!("$HOME/.claude/projects/{}/{}.jsonl", project, session_id);
    let mut cmd = std::process::Command::new("ssh");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.args(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", &ssh_target, &format!("cat {}", path)]);

    let output = tauri::async_runtime::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| format!("Task error: {e}"))?
        .map_err(|e| format!("SSH error: {e}"))?;

    if !output.status.success() {
        return Err(format!("Failed to read session: {}", String::from_utf8_lossy(&output.stderr)));
    }

    let content = String::from_utf8_lossy(&output.stdout);
    let messages: Vec<String> = content.lines()
        .map(|l| l.to_string())
        .collect();

    Ok(messages)
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
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty,
            get_workspace_info,
            get_ports,
            get_pty_pid,
            get_shell_ctx,
            list_fonts,
            send_notification,
            fetch_claude_session,
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
