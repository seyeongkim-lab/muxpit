use crate::platform::command::silent_command;
use crate::ssh_command::{
    quote_posix_shell_arg, resolve_ssh_command, split_command_line, SshCommand,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const MAX_LINE_BYTES: usize = 1024 * 1024;
const CLAUDE_SESSION_SCRIPT: &str = include_str!("../scripts/claude_sessions.py");

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopAgentProvider {
    Codex,
    Claude,
    Gemini,
    Copilot,
    Opencode,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAgentTransportEvent {
    channel_id: String,
    kind: &'static str,
    data: Option<String>,
    exit_status: Option<i32>,
}

struct DesktopAgentChannel {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    stop: SyncSender<()>,
}

#[derive(Clone, Default)]
pub struct DesktopAgentManager {
    channels: Arc<Mutex<HashMap<String, DesktopAgentChannel>>>,
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

fn provider_command(
    provider: DesktopAgentProvider,
    session_id: Option<String>,
) -> Result<String, String> {
    match provider {
        DesktopAgentProvider::Codex => {
            if session_id.is_some() {
                return Err("Codex sessions are resumed through app-server".into());
            }
            Ok("codex app-server --listen stdio://".into())
        }
        DesktopAgentProvider::Claude => {
            let resume = match session_id {
                Some(id) if valid_session_id(&id) => {
                    format!(" --resume {}", quote_posix_shell_arg(&id))
                }
                Some(_) => return Err("Invalid Claude session id".into()),
                None => String::new(),
            };
            Ok(format!(
                "claude -p --input-format stream-json --output-format stream-json --verbose{resume}"
            ))
        }
        DesktopAgentProvider::Copilot => Ok("copilot --acp --stdio".into()),
        DesktopAgentProvider::Opencode => Ok("opencode acp".into()),
        DesktopAgentProvider::Gemini => Ok("gemini --experimental-acp".into()),
    }
}

#[cfg(windows)]
fn resolve_windows_program(name: &str) -> Option<String> {
    let output = silent_command("where.exe").arg(name).output().ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|path| {
            matches!(
                std::path::Path::new(path)
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("exe" | "com" | "cmd" | "bat")
            )
        })
        .map(str::to_string)
}

fn local_command(command: &str, cwd: Option<&str>) -> Result<Command, String> {
    #[cfg(windows)]
    let mut process = {
        let parts = split_command_line(command);
        let name = parts
            .first()
            .ok_or_else(|| "Agent command is empty".to_string())?;
        let program = resolve_windows_program(name).unwrap_or_else(|| name.clone());
        let extension = std::path::Path::new(&program)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(extension.as_str(), "cmd" | "bat") {
            let mut process = silent_command("cmd.exe");
            process.args(["/D", "/C", &program]);
            process.args(&parts[1..]);
            process
        } else {
            let mut process = silent_command(program);
            process.args(&parts[1..]);
            process
        }
    };
    #[cfg(not(windows))]
    let mut process = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut process = silent_command(shell);
        process.args(["-lc", &format!("exec {command}")]);
        process
    };
    if let Some(cwd) = cwd {
        process.current_dir(cwd);
    }
    Ok(process)
}

fn target_command(
    command: &str,
    cwd: Option<&str>,
    ssh_command: Option<&str>,
    ssh_connection: Option<SshCommand>,
) -> Result<Command, String> {
    if ssh_connection.is_none() && ssh_command.is_none() {
        return local_command(command, cwd);
    }
    let ssh = resolve_ssh_command(ssh_command, ssh_connection)
        .ok_or_else(|| "Invalid SSH command".to_string())?;
    let remote = match cwd {
        Some(cwd) => format!("cd {} && exec {command}", quote_posix_shell_arg(cwd)),
        None => format!("exec {command}"),
    };
    let remote = crate::login_shell_remote_command(&remote);
    let mut process = ssh.to_command_with_extra_options(&[
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
    ]);
    process.arg(remote);
    Ok(process)
}

fn emit_stream(app: &AppHandle, channel_id: &str, kind: &'static str, data: String) {
    let _ = app.emit(
        "desktop-agent-transport",
        DesktopAgentTransportEvent {
            channel_id: channel_id.into(),
            kind,
            data: Some(data),
            exit_status: None,
        },
    );
}

fn read_stream<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    channel_id: String,
    kind: &'static str,
    stream: R,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => emit_stream(&app, &channel_id, kind, line.clone()),
                Err(error) => {
                    emit_stream(&app, &channel_id, "stderr", error.to_string());
                    break;
                }
            }
        }
    });
}

fn reap_process(
    app: AppHandle,
    manager: DesktopAgentManager,
    channel_id: String,
    mut child: Child,
    stop_rx: mpsc::Receiver<()>,
) {
    std::thread::spawn(move || {
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {}
                Err(error) => {
                    emit_stream(&app, &channel_id, "stderr", error.to_string());
                    break child.wait().ok().unwrap_or_default();
                }
            }
            match stop_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => {
                    let _ = child.kill();
                    break child.wait().ok().unwrap_or_default();
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        };
        manager.channels.lock().unwrap().remove(&channel_id);
        let _ = app.emit(
            "desktop-agent-transport",
            DesktopAgentTransportEvent {
                channel_id: channel_id.clone(),
                kind: "exit",
                data: None,
                exit_status: status.code(),
            },
        );
        let _ = app.emit(
            "desktop-agent-transport",
            DesktopAgentTransportEvent {
                channel_id,
                kind: "closed",
                data: None,
                exit_status: None,
            },
        );
    });
}

fn open_process(
    app: AppHandle,
    manager: DesktopAgentManager,
    channel_id: String,
    mut process: Command,
) -> Result<(), String> {
    if !valid_channel_id(&channel_id) {
        return Err("Invalid agent channel id".into());
    }
    if manager.channels.lock().unwrap().contains_key(&channel_id) {
        return Err("Agent channel is already open".into());
    }
    process
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = process
        .spawn()
        .map_err(|error| format!("Could not start agent: {error}"))?;
    let stdin = Arc::new(Mutex::new(child.stdin.take()));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Agent stdout is not available".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Agent stderr is not available".to_string())?;
    let (stop, stop_rx) = mpsc::sync_channel(1);
    manager.channels.lock().unwrap().insert(
        channel_id.clone(),
        DesktopAgentChannel {
            stdin: Arc::clone(&stdin),
            stop,
        },
    );
    read_stream(app.clone(), channel_id.clone(), "stdout", stdout);
    read_stream(app.clone(), channel_id.clone(), "stderr", stderr);
    reap_process(app, manager, channel_id, child, stop_rx);
    Ok(())
}

fn open_command(
    app: AppHandle,
    manager: DesktopAgentManager,
    channel_id: String,
    command: String,
    cwd: Option<String>,
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
) -> Result<(), String> {
    let cwd = checked_cwd(cwd)?;
    let process = target_command(
        &command,
        cwd.as_deref(),
        ssh_command.as_deref(),
        ssh_connection,
    )?;
    open_process(app, manager, channel_id, process)
}

#[tauri::command]
pub fn desktop_agent_open(
    app: AppHandle,
    state: State<'_, DesktopAgentManager>,
    channel_id: String,
    provider: DesktopAgentProvider,
    session_id: Option<String>,
    cwd: Option<String>,
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
) -> Result<(), String> {
    let command = provider_command(provider, session_id)?;
    open_command(
        app,
        state.inner().clone(),
        channel_id,
        command,
        cwd,
        ssh_command,
        ssh_connection,
    )
}

fn claude_script_command(arguments: &[&str], remote: bool) -> String {
    let script = base64::engine::general_purpose::STANDARD.encode(CLAUDE_SESSION_SCRIPT);
    let python = format!("import base64;exec(base64.b64decode({script:?}))");
    let executable = if cfg!(windows) && !remote { "python" } else { "python3" };
    let mut command = format!("{executable} -u -c {}", quote_posix_shell_arg(&python));
    for argument in arguments {
        command.push(' ');
        command.push_str(&quote_posix_shell_arg(argument));
    }
    command
}

#[tauri::command]
pub fn desktop_claude_sessions(
    app: AppHandle,
    state: State<'_, DesktopAgentManager>,
    channel_id: String,
    cwd: Option<String>,
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
) -> Result<(), String> {
    let remote = ssh_connection.is_some() || ssh_command.is_some();
    open_command(
        app,
        state.inner().clone(),
        channel_id,
        claude_script_command(&["list"], remote),
        cwd,
        ssh_command,
        ssh_connection,
    )
}

#[tauri::command]
pub fn desktop_claude_session(
    app: AppHandle,
    state: State<'_, DesktopAgentManager>,
    channel_id: String,
    session_id: String,
    cwd: Option<String>,
    ssh_command: Option<String>,
    ssh_connection: Option<SshCommand>,
) -> Result<(), String> {
    if !valid_session_id(&session_id) {
        return Err("Invalid Claude session id".into());
    }
    let remote = ssh_connection.is_some() || ssh_command.is_some();
    open_command(
        app,
        state.inner().clone(),
        channel_id,
        claude_script_command(&["history", &session_id], remote),
        cwd,
        ssh_command,
        ssh_connection,
    )
}

#[tauri::command]
pub fn desktop_agent_write(
    state: State<'_, DesktopAgentManager>,
    channel_id: String,
    line: String,
) -> Result<(), String> {
    if line.len() > MAX_LINE_BYTES || line.contains('\n') || line.contains('\r') {
        return Err("Invalid agent message".into());
    }
    let stdin = state
        .channels
        .lock()
        .unwrap()
        .get(&channel_id)
        .map(|channel| Arc::clone(&channel.stdin))
        .ok_or_else(|| "Agent channel is not open".to_string())?;
    let mut guard = stdin.lock().unwrap();
    let writer = guard
        .as_mut()
        .ok_or_else(|| "Agent channel input is closed".to_string())?;
    writeln!(writer, "{line}").map_err(|error| format!("Could not write to agent: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("Could not flush agent input: {error}"))
}

#[tauri::command]
pub fn desktop_agent_close(
    state: State<'_, DesktopAgentManager>,
    channel_id: String,
) -> Result<(), String> {
    let channel = state
        .channels
        .lock()
        .unwrap()
        .remove(&channel_id)
        .ok_or_else(|| "Agent channel is not open".to_string())?;
    channel.stdin.lock().unwrap().take();
    channel
        .stop
        .send(())
        .map_err(|_| "Agent channel already closed".to_string())
}

pub fn check_local_clis_sync(names: &[String]) -> HashMap<String, bool> {
    names
        .iter()
        .map(|name| {
            let safe = !name.is_empty()
                && name
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'));
            let found = safe && if cfg!(windows) {
                silent_command("where.exe")
                    .arg(name)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|status| status.success())
            } else {
                silent_command("/bin/sh")
                    .args(["-lc", &format!("command -v {name}")])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|status| status.success())
            };
            (name.clone(), found)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_commands_use_structured_protocols() {
        assert_eq!(
            provider_command(DesktopAgentProvider::Codex, None).unwrap(),
            "codex app-server --listen stdio://"
        );
        assert_eq!(
            provider_command(DesktopAgentProvider::Copilot, None).unwrap(),
            "copilot --acp --stdio"
        );
        assert_eq!(
            provider_command(DesktopAgentProvider::Opencode, None).unwrap(),
            "opencode acp"
        );
        assert_eq!(
            provider_command(DesktopAgentProvider::Gemini, None).unwrap(),
            "gemini --experimental-acp"
        );
    }

    #[test]
    fn claude_resume_id_is_validated() {
        assert!(provider_command(DesktopAgentProvider::Claude, Some("-bad".into())).is_err());
        assert!(provider_command(DesktopAgentProvider::Claude, Some("session-1".into()))
            .unwrap()
            .contains("--resume 'session-1'"));
    }
}
