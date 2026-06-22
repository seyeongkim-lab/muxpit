use crate::ServerMsg;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use wmux_core::command::apply_no_window;
use wmux_core::monitor::{MonitorData, SessionContentEvent};
use wmux_core::remote_monitor::{
    build_claude_fetch_command, build_claude_script, build_collect_script, parse_claude_sessions,
    parse_remote_output, MonitorSnapshots, CLAUDE_END_MARKER, END_MARKER,
};
use wmux_core::ssh_command::SshCommand;

#[derive(Clone)]
struct FetchRequest {
    project: String,
    session_id: String,
    request_id: String,
}

struct MonitorSession {
    stop_flag: Arc<Mutex<bool>>,
    pending_fetches: Arc<Mutex<VecDeque<FetchRequest>>>,
}

pub(crate) struct ServerMonitorManager {
    sessions: Mutex<HashMap<String, MonitorSession>>,
    tx: mpsc::UnboundedSender<ServerMsg>,
}

impl ServerMonitorManager {
    pub(crate) fn new(tx: mpsc::UnboundedSender<ServerMsg>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            tx,
        }
    }

    pub(crate) fn start(&self, monitor_id: String, ssh: SshCommand) {
        let mut sessions = self.sessions.lock().unwrap();

        if let Some(existing) = sessions.remove(&monitor_id) {
            *existing.stop_flag.lock().unwrap() = true;
        }

        let stop_flag = Arc::new(Mutex::new(false));
        let pending_fetches = Arc::new(Mutex::new(VecDeque::new()));
        let mid = monitor_id.clone();
        sessions.insert(
            monitor_id,
            MonitorSession {
                stop_flag: stop_flag.clone(),
                pending_fetches: pending_fetches.clone(),
            },
        );

        let tx = self.tx.clone();
        std::thread::spawn(move || {
            run_persistent_monitor(tx, ssh, mid, stop_flag, pending_fetches);
        });
    }

    pub(crate) fn request_session_content(
        &self,
        monitor_id: Option<&str>,
        project: String,
        session_id: String,
        request_id: String,
    ) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = select_fetch_session(&sessions, monitor_id)?;
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

    pub(crate) fn stop(&self, monitor_id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.remove(monitor_id) {
            *session.stop_flag.lock().unwrap() = true;
        }
    }

    fn stop_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, session) in sessions.drain() {
            *session.stop_flag.lock().unwrap() = true;
        }
    }
}

impl Drop for ServerMonitorManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}

fn select_fetch_session<'a>(
    sessions: &'a HashMap<String, MonitorSession>,
    monitor_id: Option<&str>,
) -> Result<&'a MonitorSession, String> {
    if let Some(mid) = monitor_id {
        if let Some(session) = sessions.get(mid) {
            return Ok(session);
        }
        if sessions.len() == 1 {
            return sessions
                .values()
                .next()
                .ok_or_else(|| "No active monitor session".to_string());
        }
        return Err(format!("Monitor session not found: {mid}"));
    }
    sessions
        .values()
        .next()
        .ok_or_else(|| "No active monitor session".to_string())
}

fn run_persistent_monitor(
    tx: mpsc::UnboundedSender<ServerMsg>,
    ssh: SshCommand,
    monitor_id: String,
    stop_flag: Arc<Mutex<bool>>,
    pending_fetches: Arc<Mutex<VecDeque<FetchRequest>>>,
) {
    let mut snapshots = MonitorSnapshots::default();

    loop {
        if *stop_flag.lock().unwrap() {
            return;
        }

        let mut cmd = ssh.to_command_with_extra_options(&[
            "-T",
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
            Ok(child) => child,
            Err(e) => {
                emit_monitor_data(
                    &tx,
                    &error_data(&monitor_id, &format!("SSH spawn failed: {e}")),
                );
                sleep_with_stop(5000, &stop_flag);
                continue;
            }
        };

        let mut stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                let _ = child.kill();
                emit_monitor_data(&tx, &error_data(&monitor_id, "Failed to get SSH stdin"));
                sleep_with_stop(5000, &stop_flag);
                continue;
            }
        };

        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill();
                emit_monitor_data(&tx, &error_data(&monitor_id, "Failed to get SSH stdout"));
                sleep_with_stop(5000, &stop_flag);
                continue;
            }
        };

        let reader = Arc::new(Mutex::new(BufReader::new(stdout)));
        let script = build_collect_script();
        let claude_script = build_claude_script();
        let mut tick_count: u32 = 0;
        let mut cached_claude_sessions = Vec::new();

        'collection: loop {
            if *stop_flag.lock().unwrap() {
                emit_pending_fetch_errors(&tx, &pending_fetches, "Monitor stopped");
                let _ = child.kill();
                let _ = child.wait();
                return;
            }

            if writeln!(stdin, "{}", script).is_err() || stdin.flush().is_err() {
                break;
            }

            let mut output = String::new();
            let ok = read_until_marker(&reader, END_MARKER, &mut output);
            if !ok {
                break;
            }

            if tick_count % 30 == 0 {
                if writeln!(stdin, "{}", claude_script).is_ok() && stdin.flush().is_ok() {
                    let mut claude_output = String::new();
                    if read_until_marker(&reader, CLAUDE_END_MARKER, &mut claude_output) {
                        cached_claude_sessions = parse_claude_sessions(&claude_output);
                    }
                }
            }
            tick_count += 1;

            let mut data = parse_remote_output(&output, &monitor_id, &mut snapshots);
            data.claude_sessions = cached_claude_sessions.clone();
            emit_monitor_data(&tx, &data);

            loop {
                let req = pending_fetches.lock().unwrap().pop_front();
                let Some(req) = req else { break };
                let fetch_marker = format!("===WMUX_FETCH_END_{}===", req.request_id);
                let cat_cmd = match build_claude_fetch_command(
                    &req.project,
                    &req.session_id,
                    &fetch_marker,
                ) {
                    Ok(cmd) => cmd,
                    Err(error) => {
                        emit_session_content(
                            &tx,
                            &SessionContentEvent {
                                request_id: req.request_id,
                                lines: vec![],
                                error: Some(error),
                            },
                        );
                        continue;
                    }
                };

                if writeln!(stdin, "{}", cat_cmd).is_err() || stdin.flush().is_err() {
                    emit_fetch_error(&tx, req, "Failed to write session fetch request");
                    emit_pending_fetch_errors(&tx, &pending_fetches, "SSH connection lost");
                    break 'collection;
                }

                let mut fetch_output = String::new();
                let fetch_ok = read_until_marker(&reader, &fetch_marker, &mut fetch_output);
                let event = if fetch_ok {
                    SessionContentEvent {
                        request_id: req.request_id,
                        lines: fetch_output.lines().map(|line| line.to_string()).collect(),
                        error: None,
                    }
                } else {
                    SessionContentEvent {
                        request_id: req.request_id,
                        lines: vec![],
                        error: Some("Failed to read session".into()),
                    }
                };
                emit_session_content(&tx, &event);
                if !fetch_ok {
                    emit_pending_fetch_errors(&tx, &pending_fetches, "SSH connection lost");
                    break 'collection;
                }
            }

            if !sleep_with_stop(1000, &stop_flag) {
                emit_pending_fetch_errors(&tx, &pending_fetches, "Monitor stopped");
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }

        let _ = child.kill();
        let _ = child.wait();
        emit_monitor_data(
            &tx,
            &error_data(&monitor_id, "SSH connection lost, reconnecting..."),
        );
        if !sleep_with_stop(3000, &stop_flag) {
            return;
        }
    }
}

fn read_until_marker(
    reader: &Arc<Mutex<BufReader<std::process::ChildStdout>>>,
    marker: &str,
    output: &mut String,
) -> bool {
    let mut rdr = reader.lock().unwrap();
    loop {
        let mut line = String::new();
        match rdr.read_line(&mut line) {
            Ok(0) => break false,
            Ok(_) => {
                if line.trim() == marker {
                    break true;
                }
                output.push_str(&line);
            }
            Err(_) => break false,
        }
    }
}

fn emit_monitor_data(tx: &mpsc::UnboundedSender<ServerMsg>, data: &MonitorData) {
    emit_event(tx, "monitor-data", data);
}

fn emit_session_content(tx: &mpsc::UnboundedSender<ServerMsg>, event: &SessionContentEvent) {
    emit_event(tx, "claude-session-content", event);
}

fn emit_event<T: serde::Serialize>(
    tx: &mpsc::UnboundedSender<ServerMsg>,
    event: &str,
    payload: &T,
) {
    let value = match serde_json::to_value(payload) {
        Ok(value) => value,
        Err(e) => {
            let _ = tx.send(ServerMsg::Error {
                req_id: None,
                message: format!("event serialization error: {e}"),
            });
            return;
        }
    };
    let _ = tx.send(ServerMsg::Event {
        event: event.to_string(),
        payload: value,
    });
}

fn emit_fetch_error(tx: &mpsc::UnboundedSender<ServerMsg>, req: FetchRequest, error: &str) {
    emit_session_content(
        tx,
        &SessionContentEvent {
            request_id: req.request_id,
            lines: vec![],
            error: Some(error.to_string()),
        },
    );
}

fn emit_pending_fetch_errors(
    tx: &mpsc::UnboundedSender<ServerMsg>,
    pending_fetches: &Arc<Mutex<VecDeque<FetchRequest>>>,
    error: &str,
) {
    let fetch_reqs: Vec<FetchRequest> = pending_fetches.lock().unwrap().drain(..).collect();
    for req in fetch_reqs {
        emit_fetch_error(tx, req, error);
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_session() -> MonitorSession {
        MonitorSession {
            stop_flag: Arc::new(Mutex::new(false)),
            pending_fetches: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    #[test]
    fn stale_monitor_id_falls_back_when_only_one_session_is_active() {
        let sessions = HashMap::from([("fresh".to_string(), test_session())]);

        assert!(select_fetch_session(&sessions, Some("stale")).is_ok());
    }

    #[test]
    fn stale_monitor_id_is_rejected_when_fallback_would_be_ambiguous() {
        let sessions = HashMap::from([
            ("one".to_string(), test_session()),
            ("two".to_string(), test_session()),
        ]);

        assert!(select_fetch_session(&sessions, Some("stale")).is_err());
    }
}
