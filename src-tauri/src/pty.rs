use crate::tmux_cc::{shell_single_quote, TmuxCcParser, TmuxEvent};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyOutput {
    pub id: u32,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyExit {
    pub id: u32,
    pub code: Option<i32>,
}

struct TmuxCcState {
    /// Pane id (e.g. `%0`) that user keystrokes should be routed to via `send-keys`.
    /// Set on first `%output` received after attach.
    active_pane: Option<String>,
}

struct PtyInstance {
    writer: Box<dyn Write + Send>,
    _master: Box<dyn MasterPty + Send>,
    child_pid: Option<u32>,
    tmux_state: Option<Arc<Mutex<TmuxCcState>>>,
}

pub struct PtyManager {
    instances: Mutex<HashMap<u32, PtyInstance>>,
    next_id: Mutex<u32>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }

    pub fn spawn(
        &self,
        app: AppHandle,
        rows: u16,
        cols: u16,
        command: Option<String>,
    ) -> Result<u32, String> {
        self.spawn_internal(app, rows, cols, command, false)
    }

    /// Spawn an SSH connection that wraps the remote shell in `tmux new-session -A -s SESSION`.
    /// Uses *plain* tmux attach (not control mode): xterm renders tmux's own screen directly,
    /// which gives us session persistence without the complexity of -CC protocol handling.
    /// Reconnect is handled by the frontend retrying this same call with the same session_name;
    /// tmux's `new -A` attaches to the existing server-side session if it's still alive.
    ///
    /// `ssh_command` is the user-supplied SSH invocation (e.g. `"ssh -p 22 user@host"`).
    /// `session_name` is the tmux session name to attach/create (sanitised internally).
    pub fn spawn_tmux_cc(
        &self,
        app: AppHandle,
        rows: u16,
        cols: u16,
        ssh_command: String,
        session_name: String,
    ) -> Result<u32, String> {
        // tmux session names cannot contain '.' or ':'; replace with '_'.
        let safe: String = session_name
            .chars()
            .map(|c| match c {
                '.' | ':' | ' ' | '\t' | '\n' | '\r' => '_',
                _ => c,
            })
            .collect();
        // Hide tmux's status bar so the pane looks like a plain shell — wmux's own sidebar
        // already shows session/pane info, and the bar is visual noise. `\; set ...` chains
        // tmux commands so they run against the session we just created/attached.
        let tmux_inner = format!(
            "tmux new-session -A -s {} \\; set -g status off",
            shell_single_quote(&safe),
        );
        let full = format!("{} -t {}", ssh_command, shell_single_quote(&tmux_inner));
        // tmux_cc=false: we no longer use control mode. Keep the parser module for a future
        // re-introduction of real pane mapping (see TODO Phase 10 Step 1: pane mapping policy).
        self.spawn_internal(app, rows, cols, Some(full), false)
    }

    fn spawn_internal(
        &self,
        app: AppHandle,
        rows: u16,
        cols: u16,
        command: Option<String>,
        tmux_cc: bool,
    ) -> Result<u32, String> {
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {e}"))?;

        // If command is provided, run it directly; otherwise use default shell
        let mut cmd = if let Some(ref command_str) = command {
            let parts = shell_words_parse(command_str);
            if parts.is_empty() {
                return Err("Empty command".to_string());
            }
            let mut cb = CommandBuilder::new(&parts[0]);
            for arg in &parts[1..] {
                cb.arg(arg);
            }
            cb
        } else if cfg!(windows) {
            let pwsh = which_powershell();
            CommandBuilder::new(pwsh)
        } else {
            CommandBuilder::new_default_prog()
        };
        cmd.env("TERM", "xterm-256color");

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {e}"))?;

        let child_pid = child.process_id();

        let id = {
            let mut next = self.next_id.lock().unwrap();
            let id = *next;
            *next += 1;
            id
        };

        let tmux_state = if tmux_cc {
            Some(Arc::new(Mutex::new(TmuxCcState { active_pane: None })))
        } else {
            None
        };

        // Read thread: PTY stdout -> frontend event (optionally via tmux-CC parser)
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {e}"))?;

        let app_clone = app.clone();
        let pty_id = id;
        let reader_tmux_state = tmux_state.clone();
        std::thread::spawn(move || {
            let mut parser = if reader_tmux_state.is_some() {
                Some(TmuxCcParser::new())
            } else {
                None
            };
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = app_clone.emit(
                            "pty-exit",
                            PtyExit {
                                id: pty_id,
                                code: None,
                            },
                        );
                        break;
                    }
                    Ok(n) => {
                        let chunk = &buf[..n];
                        if let (Some(p), Some(state)) =
                            (parser.as_mut(), reader_tmux_state.as_ref())
                        {
                            for event in p.feed(chunk) {
                                handle_tmux_event(event, pty_id, state, &app_clone);
                            }
                        } else {
                            let text = String::from_utf8_lossy(chunk).to_string();
                            let _ = app_clone.emit(
                                "pty-output",
                                PtyOutput {
                                    id: pty_id,
                                    data: text,
                                },
                            );
                        }
                    }
                    Err(_) => {
                        let _ = app_clone.emit(
                            "pty-exit",
                            PtyExit {
                                id: pty_id,
                                code: None,
                            },
                        );
                        break;
                    }
                }
            }
        });

        // Child watcher thread: detect process exit
        let app_clone2 = app.clone();
        let pty_id2 = id;
        std::thread::spawn(move || {
            let status = child.wait();
            let code = status.ok().map(|s| s.exit_code() as i32);
            let _ = app_clone2.emit(
                "pty-exit",
                PtyExit {
                    id: pty_id2,
                    code,
                },
            );
        });

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take writer: {e}"))?;

        {
            let mut instances = self.instances.lock().unwrap();
            instances.insert(
                id,
                PtyInstance {
                    writer,
                    _master: pair.master,
                    child_pid,
                    tmux_state,
                },
            );
        }

        Ok(id)
    }

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().unwrap();
        let instance = instances
            .get_mut(&id)
            .ok_or_else(|| format!("PTY {id} not found"))?;

        let payload: Vec<u8> = if let Some(state) = &instance.tmux_state {
            let pane = state.lock().unwrap().active_pane.clone();
            match pane {
                Some(pane) => {
                    // Route via tmux send-keys so keystrokes go to the active remote pane
                    // rather than being interpreted as tmux control-mode commands.
                    let cmd = format!(
                        "send-keys -t {} -l {}\n",
                        pane,
                        shell_single_quote(data)
                    );
                    cmd.into_bytes()
                }
                // No pane discovered yet (pre-attach). Pass through — tmux may echo as command,
                // but this window is brief (before first %output).
                None => data.as_bytes().to_vec(),
            }
        } else {
            data.as_bytes().to_vec()
        };

        instance
            .writer
            .write_all(&payload)
            .map_err(|e| format!("Write error: {e}"))?;
        instance
            .writer
            .flush()
            .map_err(|e| format!("Flush error: {e}"))?;
        Ok(())
    }

    pub fn resize(&self, id: u32, rows: u16, cols: u16) -> Result<(), String> {
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
            .map_err(|e| format!("Resize error: {e}"))?;
        Ok(())
    }

    pub fn kill(&self, id: u32) -> Result<(), String> {
        let mut instances = self.instances.lock().unwrap();
        instances
            .remove(&id)
            .ok_or_else(|| format!("PTY {id} not found"))?;
        // Dropping the instance closes the master PTY, which signals the child
        Ok(())
    }

    pub fn get_child_pid(&self, id: u32) -> Result<Option<u32>, String> {
        let instances = self.instances.lock().unwrap();
        let instance = instances
            .get(&id)
            .ok_or_else(|| format!("PTY {id} not found"))?;
        Ok(instance.child_pid)
    }
}

fn handle_tmux_event(
    event: TmuxEvent,
    pty_id: u32,
    state: &Arc<Mutex<TmuxCcState>>,
    app: &AppHandle,
) {
    match event {
        TmuxEvent::Output { pane_id, data } => {
            // First pane we observe becomes the active send-keys target for this session.
            {
                let mut s = state.lock().unwrap();
                if s.active_pane.is_none() {
                    s.active_pane = Some(pane_id);
                }
            }
            let text = String::from_utf8_lossy(&data).into_owned();
            let _ = app.emit(
                "pty-output",
                PtyOutput {
                    id: pty_id,
                    data: text,
                },
            );
        }
        TmuxEvent::WindowPaneChanged { pane_id, .. } => {
            state.lock().unwrap().active_pane = Some(pane_id);
        }
        TmuxEvent::Exit { .. } => {
            let _ = app.emit(
                "pty-exit",
                PtyExit {
                    id: pty_id,
                    code: None,
                },
            );
        }
        // Other notifications are not acted on for MVP; ignore silently.
        _ => {}
    }
}

// Make PtyManager safe to use as Tauri state
unsafe impl Send for PtyManager {}
unsafe impl Sync for PtyManager {}

#[cfg(windows)]
fn which_powershell() -> std::ffi::OsString {
    // Prefer pwsh (PowerShell 7+), fall back to Windows PowerShell
    for name in &["pwsh.exe", "powershell.exe"] {
        let mut cmd = std::process::Command::new("where");
        cmd.arg(name);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout);
                if let Some(first_line) = path.lines().next() {
                    return std::ffi::OsString::from(first_line.trim());
                }
            }
        }
    }
    std::ffi::OsString::from("cmd.exe")
}

#[cfg(not(windows))]
fn which_powershell() -> std::ffi::OsString {
    std::ffi::OsString::from("/bin/sh")
}

/// Simple shell-like word splitting that respects quotes
fn shell_words_parse(s: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escape = false;

    for ch in s.chars() {
        if escape {
            current.push(ch);
            escape = false;
            continue;
        }
        match ch {
            '\\' if !in_single && !cfg!(windows) => escape = true,
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            ' ' | '\t' if !in_single && !in_double => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}
