use crate::platform::command::apply_no_window;
use crate::remote_monitor::{
    build_claude_fetch_command, build_claude_script, build_collect_script, parse_claude_sessions,
    parse_remote_output, MonitorSnapshots, CLAUDE_END_MARKER, END_MARKER,
};
use crate::ssh_command::SshCommand;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub user: String,
    pub cpu: f64,
    pub mem: f64,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetInfo {
    pub rx_bytes_per_sec: u64,
    pub tx_bytes_per_sec: u64,
    /// NIC link speed in Mbps (e.g. 1000 for 1Gbps, 10000 for 10Gbps). None if unknown.
    pub link_speed_mbps: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSession {
    pub project: String,
    pub project_path: String,
    pub session_id: String,
    pub started_at: Option<String>,
    pub last_activity: Option<String>,
    pub message_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorData {
    pub monitor_id: String,
    pub cpu_percent: f64,
    pub mem_total_mb: u64,
    pub mem_used_mb: u64,
    pub mem_percent: f64,
    pub load_avg: [f64; 3],
    pub processes: Vec<ProcessInfo>,
    pub hostname: String,
    pub timestamp: u64,
    pub error: Option<String>,
    pub net: Option<NetInfo>,
    pub disks: Vec<DiskInfo>,
    pub claude_sessions: Vec<ClaudeSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskInfo {
    pub mount: String,
    pub total_gb: f64,
    pub used_gb: f64,
    pub percent: f64,
}

/// A request to fetch a file via the monitor's SSH connection.
#[derive(Clone)]
struct FetchRequest {
    project: String,
    session_id: String,
    request_id: String,
}

/// Response emitted via "claude-session-content" event.
#[derive(Clone, Serialize)]
struct SessionContentEvent {
    request_id: String,
    lines: Vec<String>,
    error: Option<String>,
}

struct MonitorSession {
    stop_flag: Arc<Mutex<bool>>,
    pending_fetches: Arc<Mutex<VecDeque<FetchRequest>>>,
}

pub struct MonitorManager {
    sessions: Mutex<HashMap<String, MonitorSession>>,
}

impl MonitorManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn start(&self, app: AppHandle, monitor_id: String, ssh: SshCommand) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();

        // Stop existing session with same ID
        if let Some(existing) = sessions.remove(&monitor_id) {
            *existing.stop_flag.lock().unwrap() = true;
        }

        let stop_flag = Arc::new(Mutex::new(false));
        let stop_flag_clone = stop_flag.clone();
        let pending_fetches: Arc<Mutex<VecDeque<FetchRequest>>> =
            Arc::new(Mutex::new(VecDeque::new()));
        let pending_fetches_clone = pending_fetches.clone();
        let mid = monitor_id.clone();

        sessions.insert(
            monitor_id,
            MonitorSession {
                stop_flag,
                pending_fetches,
            },
        );

        // Spawn persistent SSH connection thread
        std::thread::spawn(move || {
            run_persistent_monitor(&app, &ssh, &mid, &stop_flag_clone, &pending_fetches_clone);
        });

        Ok(())
    }

    pub fn request_session_content(
        &self,
        monitor_id: Option<&str>,
        project: String,
        session_id: String,
        request_id: String,
    ) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        // Try specified monitor first, then fall back to any active monitor
        let session = if let Some(mid) = monitor_id {
            sessions.get(mid)
        } else {
            None
        }
        .or_else(|| sessions.values().next());
        let session = session.ok_or_else(|| "No active monitor session".to_string())?;
        session
            .pending_fetches
            .lock()
            .unwrap()
            .push_back(FetchRequest {
                project,
                session_id,
                request_id,
            });
        Ok(())
    }

    pub fn stop(&self, monitor_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.remove(monitor_id) {
            *session.stop_flag.lock().unwrap() = true;
        }
        // Silently ignore if session not found (may already be stopped during rapid switching)
        Ok(())
    }
}

unsafe impl Send for MonitorManager {}
unsafe impl Sync for MonitorManager {}

/// Run a persistent SSH session, sending collection commands every 1 second
fn run_persistent_monitor(
    app: &AppHandle,
    parsed_ssh: &SshCommand,
    monitor_id: &str,
    stop_flag: &Arc<Mutex<bool>>,
    pending_fetches: &Arc<Mutex<VecDeque<FetchRequest>>>,
) {
    let mut snapshots = MonitorSnapshots::default();

    loop {
        if *stop_flag.lock().unwrap() {
            return;
        }

        // Spawn persistent SSH process
        let mut cmd = parsed_ssh.to_command_with_extra_options(&[
            "-T", // No PTY allocation
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=5",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ServerAliveInterval=10",
            "-o",
            "ServerAliveCountMax=3",
        ]);
        apply_no_window(&mut cmd);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::null());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit(
                    "monitor-data",
                    &error_data(monitor_id, &format!("SSH spawn failed: {e}")),
                );
                // Wait before retry
                sleep_with_stop(5000, stop_flag);
                continue;
            }
        };

        let mut stdin = match child.stdin.take() {
            Some(s) => s,
            None => {
                let _ = child.kill();
                let _ = app.emit(
                    "monitor-data",
                    &error_data(monitor_id, "Failed to get SSH stdin"),
                );
                sleep_with_stop(5000, stop_flag);
                continue;
            }
        };

        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                let _ = child.kill();
                let _ = app.emit(
                    "monitor-data",
                    &error_data(monitor_id, "Failed to get SSH stdout"),
                );
                sleep_with_stop(5000, stop_flag);
                continue;
            }
        };

        let reader = BufReader::new(stdout);
        let reader = Arc::new(Mutex::new(reader));
        let script = build_collect_script();
        let claude_script = build_claude_script();
        let mut tick_count: u32 = 0;
        let mut cached_claude_sessions: Vec<ClaudeSession> = Vec::new();

        // Collection loop on this SSH connection
        loop {
            if *stop_flag.lock().unwrap() {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }

            // Send collection command
            if writeln!(stdin, "{}", script).is_err() || stdin.flush().is_err() {
                // SSH connection broken, break to reconnect
                break;
            }

            // Read until END_MARKER
            let mut output = String::new();
            let ok = {
                let mut rdr = reader.lock().unwrap();
                loop {
                    let mut line = String::new();
                    match rdr.read_line(&mut line) {
                        Ok(0) => break false, // EOF — connection closed
                        Ok(_) => {
                            if line.trim() == END_MARKER {
                                break true;
                            }
                            output.push_str(&line);
                        }
                        Err(_) => break false,
                    }
                }
            };

            if !ok {
                // Connection lost, break to reconnect
                break;
            }

            // Every 30 ticks (30 seconds), also collect Claude sessions
            if tick_count % 30 == 0 {
                if writeln!(stdin, "{}", claude_script).is_ok() && stdin.flush().is_ok() {
                    let mut claude_output = String::new();
                    let claude_ok = {
                        let mut rdr = reader.lock().unwrap();
                        loop {
                            let mut line = String::new();
                            match rdr.read_line(&mut line) {
                                Ok(0) => break false,
                                Ok(_) => {
                                    if line.trim() == CLAUDE_END_MARKER {
                                        break true;
                                    }
                                    claude_output.push_str(&line);
                                }
                                Err(_) => break false,
                            }
                        }
                    };
                    if claude_ok {
                        cached_claude_sessions = parse_claude_sessions(&claude_output);
                    }
                }
            }
            tick_count += 1;

            let mut data = parse_remote_output(&output, monitor_id, &mut snapshots);
            data.claude_sessions = cached_claude_sessions.clone();
            let _ = app.emit("monitor-data", &data);

            // Check for pending session content fetches
            let fetch_reqs: Vec<FetchRequest> = {
                let mut queue = pending_fetches.lock().unwrap();
                queue.drain(..).collect()
            };
            for req in fetch_reqs {
                let fetch_marker = format!("===WMUX_FETCH_END_{}===", req.request_id);
                let cat_cmd = match build_claude_fetch_command(
                    &req.project,
                    &req.session_id,
                    &fetch_marker,
                ) {
                    Ok(cmd) => cmd,
                    Err(error) => {
                        let event = SessionContentEvent {
                            request_id: req.request_id,
                            lines: vec![],
                            error: Some(error),
                        };
                        let _ = app.emit("claude-session-content", &event);
                        continue;
                    }
                };
                if writeln!(stdin, "{}", cat_cmd).is_ok() && stdin.flush().is_ok() {
                    let mut fetch_output = String::new();
                    let fetch_ok = {
                        let mut rdr = reader.lock().unwrap();
                        loop {
                            let mut line = String::new();
                            match rdr.read_line(&mut line) {
                                Ok(0) => break false,
                                Ok(_) => {
                                    if line.trim() == fetch_marker {
                                        break true;
                                    }
                                    fetch_output.push_str(&line);
                                }
                                Err(_) => break false,
                            }
                        }
                    };
                    let event = if fetch_ok {
                        let lines: Vec<String> =
                            fetch_output.lines().map(|l| l.to_string()).collect();
                        SessionContentEvent {
                            request_id: req.request_id,
                            lines,
                            error: None,
                        }
                    } else {
                        SessionContentEvent {
                            request_id: req.request_id,
                            lines: vec![],
                            error: Some("Failed to read session".into()),
                        }
                    };
                    let _ = app.emit("claude-session-content", &event);
                }
            }

            // Sleep 1 second, checking stop flag every 250ms
            for _ in 0..4 {
                if *stop_flag.lock().unwrap() {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }

        // Clean up broken connection
        let _ = child.kill();
        let _ = child.wait();

        // Emit error and wait before reconnecting
        let _ = app.emit(
            "monitor-data",
            &error_data(monitor_id, "SSH connection lost, reconnecting..."),
        );
        if !sleep_with_stop(3000, stop_flag) {
            return;
        }
    }
}

/// Sleep for `ms` milliseconds, checking stop_flag every 250ms. Returns false if stopped.
fn sleep_with_stop(ms: u64, stop_flag: &Arc<Mutex<bool>>) -> bool {
    let ticks = ms / 250;
    for _ in 0..ticks {
        if *stop_flag.lock().unwrap() {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    true
}

fn error_data(monitor_id: &str, msg: &str) -> MonitorData {
    MonitorData {
        monitor_id: monitor_id.to_string(),
        cpu_percent: 0.0,
        mem_total_mb: 0,
        mem_used_mb: 0,
        mem_percent: 0.0,
        load_avg: [0.0; 3],
        processes: vec![],
        hostname: String::new(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        error: Some(msg.to_string()),
        net: None,
        disks: vec![],
        claude_sessions: vec![],
    }
}
