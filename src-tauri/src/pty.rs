use crate::platform::pty as platform_pty;
use crate::ssh_command::{resolve_ssh_command, split_command_line, SshCommand};
use crate::tmux_cc::{shell_single_quote, TmuxCcParser, TmuxEvent};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutput {
    pub id: u32,
    pub data: String,
    pub surface_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub id: u32,
    pub code: Option<i32>,
    pub surface_id: Option<String>,
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
    workspace_id: Option<String>,
    surface_id: Option<String>,
    agent_session_token: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PendingAgentSessionToken {
    workspace_id: String,
    surface_id: String,
    token: String,
}

#[derive(Debug, Clone, Default)]
pub struct WmuxPtyContext {
    pub workspace_id: Option<String>,
    pub surface_id: Option<String>,
    pub enable_agent_session_reporting: bool,
}

pub struct PtyManager {
    instances: Mutex<HashMap<u32, PtyInstance>>,
    pending_agent_session_tokens: Mutex<Vec<PendingAgentSessionToken>>,
    next_id: Mutex<u32>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
            pending_agent_session_tokens: Mutex::new(Vec::new()),
            next_id: Mutex::new(1),
        }
    }

    pub fn spawn(
        &self,
        app: AppHandle,
        rows: u16,
        cols: u16,
        command: Option<String>,
        command_argv: Option<Vec<String>>,
        cwd: Option<String>,
        enable_cwd_reporting: bool,
        wmux_context: WmuxPtyContext,
    ) -> Result<u32, String> {
        self.spawn_internal(
            app,
            rows,
            cols,
            command,
            command_argv,
            cwd,
            enable_cwd_reporting,
            false,
            wmux_context,
        )
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
        ssh_command: Option<String>,
        ssh_connection: Option<SshCommand>,
        session_name: String,
        wmux_context: WmuxPtyContext,
    ) -> Result<u32, String> {
        // Sanitise strictly to [a-zA-Z0-9_-]. tmux rejects `.` and `:`, and we *also* want the
        // result to be shell-safe so we don't have to quote it — any `'` in the inner string
        // would end up escaped as `'\''` by shell_single_quote, and spawn_internal's
        // shell_words_parse skips `\` handling on Windows (to preserve paths like `C:\Users\…`),
        // leaving stray backslashes inside the session name. Past symptoms: `wmux-host\\`,
        // `wmux-host `, each connect creating a brand new session.
        let safe: String = session_name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        // Disable mouse on the target session so xterm's drag-to-select survives on the client:
        // when tmux has `mouse on` (common via users' ~/.tmux.conf), tmux captures mousedown and
        // swallows the browser-level selection, making copy-by-drag impossible in the wmux pane.
        //
        // Chaining via tmux's native `\; set -g mouse off` is NOT safe here — spawn_internal's
        // shell_words_parse skips `\` handling on Windows (commit a3b6f10 lesson) so the escape
        // drops through to tmux as a bare `;` and gets misinterpreted. Instead, do a three-step
        // sequence inside a remote `sh -c`:
        //   1. ensure the session exists (create detached if not)
        //   2. set mouse off *only on that session* (don't touch global -g, so other tmux
        //      sessions on the same server keep the user's preference)
        //   3. exec into attach so tmux replaces sh and ssh tracks tmux's lifetime
        // `safe` is [a-zA-Z0-9_-] only, so no inner quoting is needed. Inner uses `"` because the
        // whole thing is wrapped in `'` by shell_single_quote below.
        // `-u` forces UTF-8 mode regardless of the remote locale. Without it, tmux auto-detects
        // via LANG/LC_CTYPE, and SSH typically doesn't forward those — the remote tmux falls back
        // to ASCII width calculation and Powerline/Nerd-Font glyphs (PUA U+E000-U+F8FF) render as
        // replacement placeholders (`_`). The starship prompt shows up fine outside tmux because
        // the login shell inherits the system locale directly.
        // `set -g detach-on-destroy off`: when the user ends the session they
        // are currently in (typing `exit`, kill-session from inside, etc.),
        // tmux switches the client to another live session instead of
        // detaching. Without this the SSH connection drops and wmux tears
        // down the pane (taking any AI split with it). Applied with -g so
        // it covers user-created sessions too, not just the wrapper.
        // `set -g set-clipboard on` + `set -ga terminal-features ',*:clipboard'`:
        // forward tmux copies (mouse drag, copy-mode) to the local clipboard via
        // OSC 52, which the frontend terminal surface receives. This saves the
        // user from editing their remote ~/.tmux.conf. The value is single-quoted
        // so the remote `sh -c` does not glob `*`; single quotes are literal
        // inside the surrounding double quotes. `terminal-features` needs tmux
        // 3.2+, so it is silenced on older servers (set-clipboard still applies).
        let tmux_inner = format!(
            "sh -c \"tmux -u has-session -t {name} 2>/dev/null || tmux -u new-session -d -s {name}; tmux -u set-option -t {name} mouse off; tmux -u set-option -g detach-on-destroy off; tmux -u set-option -g set-clipboard on; tmux -u set-option -ga terminal-features ',*:clipboard' 2>/dev/null; exec tmux -u attach -t {name}\"",
            name = safe
        );
        let ssh = resolve_ssh_command(ssh_command.as_deref(), ssh_connection)
            .ok_or_else(|| "Invalid SSH command".to_string())?;
        // Force tty allocation with `-tt`, not `-t`. A single `-t` only requests a
        // remote pty when the ssh client itself has a local tty; the Windows ConPTY
        // that wmux runs ssh.exe under is not detected as one, so `-t` silently skips
        // allocation and the remote `tmux attach` dies with "open terminal failed: not
        // a terminal", spinning the reconnect loop. `-tt` forces it on every platform.
        let argv = ssh.argv_with_extra_options(&["-tt"], Some(&tmux_inner));
        // tmux_cc=false: we no longer use control mode. Keep the parser module for a future
        // re-introduction of real pane mapping (see TODO Phase 10 Step 1: pane mapping policy).
        self.spawn_internal(
            app,
            rows,
            cols,
            None,
            Some(argv),
            None,
            false,
            false,
            wmux_context,
        )
    }

    fn spawn_internal(
        &self,
        app: AppHandle,
        rows: u16,
        cols: u16,
        command: Option<String>,
        command_argv: Option<Vec<String>>,
        cwd: Option<String>,
        enable_cwd_reporting: bool,
        tmux_cc: bool,
        wmux_context: WmuxPtyContext,
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
        let mut cmd = if let Some(ref argv) = command_argv {
            command_builder_from_argv(argv)?
        } else if let Some(ref command_str) = command {
            let parts = shell_words_parse(command_str);
            if parts.is_empty() {
                return Err("Empty command".to_string());
            }
            command_builder_from_argv(&parts)?
        } else {
            platform_pty::default_shell_command(enable_cwd_reporting)
        };
        if let Some(cwd) = valid_spawn_cwd(cwd) {
            cmd.cwd(cwd.as_os_str());
        }
        let agent_session_token = if wmux_context.enable_agent_session_reporting
            && wmux_context
                .workspace_id
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            && wmux_context
                .surface_id
                .as_deref()
                .is_some_and(|value| !value.is_empty())
        {
            Some(generate_agent_session_token()?)
        } else {
            None
        };
        let mut pending_agent_session_token = self
            .register_pending_agent_session_token(&wmux_context, agent_session_token.as_deref());
        cmd.env("TERM", "xterm-256color");
        platform_pty::apply_wmux_env(
            &mut cmd,
            wmux_context.workspace_id.as_deref(),
            wmux_context.surface_id.as_deref(),
            agent_session_token.as_deref(),
        );

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
        let reader_surface_id = wmux_context.surface_id.clone();

        // Plain (non-tmux) output is coalesced on a short time window by a
        // dedicated emitter thread. This collapses the many small reads of a
        // high-throughput burst into a handful of Tauri events, and re-joins
        // multi-byte UTF-8 sequences that a 4KB read boundary would otherwise
        // split into replacement characters.
        let output_tx = if reader_tmux_state.is_none() {
            let (tx, rx) = mpsc::channel::<OutputMsg>();
            let emit_app = app.clone();
            let emit_surface = reader_surface_id.clone();
            std::thread::spawn(move || {
                run_output_emitter(rx, pty_id, emit_surface, emit_app);
            });
            Some(tx)
        } else {
            None
        };

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
                        emit_reader_exit(&output_tx, &app_clone, pty_id, &reader_surface_id);
                        break;
                    }
                    Ok(n) => {
                        let chunk = &buf[..n];
                        if let (Some(p), Some(state)) =
                            (parser.as_mut(), reader_tmux_state.as_ref())
                        {
                            for event in p.feed(chunk) {
                                handle_tmux_event(
                                    event,
                                    pty_id,
                                    reader_surface_id.as_deref(),
                                    state,
                                    &app_clone,
                                );
                            }
                        } else if let Some(tx) = &output_tx {
                            if tx.send(OutputMsg::Data(chunk.to_vec())).is_err() {
                                break;
                            }
                        }
                    }
                    Err(_) => {
                        emit_reader_exit(&output_tx, &app_clone, pty_id, &reader_surface_id);
                        break;
                    }
                }
            }
        });

        // Child watcher thread: detect process exit
        let app_clone2 = app.clone();
        let pty_id2 = id;
        let child_surface_id = wmux_context.surface_id.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            let code = status.ok().map(|s| s.exit_code() as i32);
            log::info!("pty child exited id={pty_id2} code={code:?}");
            let _ = app_clone2.emit(
                "pty-exit",
                PtyExit {
                    id: pty_id2,
                    code,
                    surface_id: child_surface_id,
                },
            );
        });

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take writer: {e}"))?;

        let workspace_id_log = wmux_context.workspace_id.clone();
        let surface_id_log = wmux_context.surface_id.clone();
        {
            let mut instances = self.instances.lock().unwrap();
            instances.insert(
                id,
                PtyInstance {
                    writer,
                    _master: pair.master,
                    child_pid,
                    tmux_state,
                    workspace_id: wmux_context.workspace_id,
                    surface_id: wmux_context.surface_id,
                    agent_session_token,
                },
            );
        }
        log::info!(
            "pty spawned id={} pid={:?} workspace={:?} surface={:?} tmux={} command_kind={}",
            id,
            child_pid,
            workspace_id_log,
            surface_id_log,
            tmux_cc,
            if command_argv.is_some() {
                "argv"
            } else if command.is_some() {
                "command"
            } else {
                "default"
            }
        );
        pending_agent_session_token.finish();

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
                    let cmd = format!("send-keys -t {} -l {}\n", pane, shell_single_quote(data));
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

    pub fn agent_session_token_matches(
        &self,
        workspace_id: &str,
        surface_id: &str,
        token: &str,
    ) -> bool {
        if workspace_id.is_empty() || surface_id.is_empty() || token.is_empty() {
            return false;
        }
        let instances = self.instances.lock().unwrap();
        if instances.values().any(|instance| {
            instance.workspace_id.as_deref() == Some(workspace_id)
                && instance.surface_id.as_deref() == Some(surface_id)
                && instance.agent_session_token.as_deref() == Some(token)
        }) {
            return true;
        }
        drop(instances);

        let pending = self.pending_agent_session_tokens.lock().unwrap();
        pending.iter().any(|entry| {
            entry.workspace_id == workspace_id
                && entry.surface_id == surface_id
                && entry.token == token
        })
    }

    fn register_pending_agent_session_token<'a>(
        &'a self,
        context: &WmuxPtyContext,
        token: Option<&str>,
    ) -> PendingAgentSessionTokenGuard<'a> {
        let Some(token) = token.filter(|value| !value.is_empty()) else {
            return PendingAgentSessionTokenGuard::empty(self);
        };
        let Some(workspace_id) = context
            .workspace_id
            .as_deref()
            .filter(|value| !value.is_empty())
        else {
            return PendingAgentSessionTokenGuard::empty(self);
        };
        let Some(surface_id) = context
            .surface_id
            .as_deref()
            .filter(|value| !value.is_empty())
        else {
            return PendingAgentSessionTokenGuard::empty(self);
        };
        let entry = PendingAgentSessionToken {
            workspace_id: workspace_id.to_string(),
            surface_id: surface_id.to_string(),
            token: token.to_string(),
        };
        self.pending_agent_session_tokens
            .lock()
            .unwrap()
            .push(entry.clone());
        PendingAgentSessionTokenGuard {
            manager: self,
            entry: Some(entry),
        }
    }

    fn remove_pending_agent_session_token(&self, entry: &PendingAgentSessionToken) {
        let mut pending = self.pending_agent_session_tokens.lock().unwrap();
        pending.retain(|candidate| candidate != entry);
    }
}

struct PendingAgentSessionTokenGuard<'a> {
    manager: &'a PtyManager,
    entry: Option<PendingAgentSessionToken>,
}

impl<'a> PendingAgentSessionTokenGuard<'a> {
    fn empty(manager: &'a PtyManager) -> Self {
        Self {
            manager,
            entry: None,
        }
    }

    fn finish(&mut self) {
        if let Some(entry) = self.entry.take() {
            self.manager.remove_pending_agent_session_token(&entry);
        }
    }
}

impl Drop for PendingAgentSessionTokenGuard<'_> {
    fn drop(&mut self) {
        if let Some(entry) = self.entry.take() {
            self.manager.remove_pending_agent_session_token(&entry);
        }
    }
}

/// Message sent from the PTY reader thread to its output emitter thread.
enum OutputMsg {
    Data(Vec<u8>),
    Exit(Option<i32>),
}

/// Routes the reader thread's EOF/error exit through the emitter (so any
/// buffered output flushes first) when output is coalesced, or emits the
/// `pty-exit` event directly for the tmux path which has no emitter thread.
fn emit_reader_exit(
    output_tx: &Option<mpsc::Sender<OutputMsg>>,
    app: &AppHandle,
    pty_id: u32,
    surface_id: &Option<String>,
) {
    if let Some(tx) = output_tx {
        let _ = tx.send(OutputMsg::Exit(None));
    } else {
        log::info!("pty reader exited id={pty_id}");
        let _ = app.emit(
            "pty-exit",
            PtyExit {
                id: pty_id,
                code: None,
                surface_id: surface_id.clone(),
            },
        );
    }
}

/// Coalesces plain PTY output on a short time window and emits batched
/// `pty-output` events, then a final `pty-exit` once the reader signals EOF.
fn run_output_emitter(
    rx: mpsc::Receiver<OutputMsg>,
    pty_id: u32,
    surface_id: Option<String>,
    app: AppHandle,
) {
    const WINDOW: Duration = Duration::from_millis(8);
    const FLUSH_THRESHOLD: usize = 64 * 1024;
    let mut acc: Vec<u8> = Vec::with_capacity(16 * 1024);
    loop {
        match rx.recv_timeout(WINDOW) {
            Ok(OutputMsg::Data(bytes)) => {
                acc.extend_from_slice(&bytes);
                if acc.len() >= FLUSH_THRESHOLD {
                    flush_output(&mut acc, pty_id, &surface_id, &app, false);
                }
            }
            Ok(OutputMsg::Exit(code)) => {
                flush_output(&mut acc, pty_id, &surface_id, &app, true);
                let _ = app.emit(
                    "pty-exit",
                    PtyExit {
                        id: pty_id,
                        code,
                        surface_id: surface_id.clone(),
                    },
                );
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                flush_output(&mut acc, pty_id, &surface_id, &app, false);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                flush_output(&mut acc, pty_id, &surface_id, &app, true);
                break;
            }
        }
    }
}

/// Emits the valid UTF-8 prefix of `acc` as a `pty-output` event. A trailing
/// incomplete multi-byte sequence is kept in `acc` for the next flush so it is
/// never split into replacement characters — unless `final_flush` is set (EOF),
/// where the remainder is emitted lossily.
fn flush_output(
    acc: &mut Vec<u8>,
    pty_id: u32,
    surface_id: &Option<String>,
    app: &AppHandle,
    final_flush: bool,
) {
    if acc.is_empty() {
        return;
    }
    let emit = |text: String| {
        let _ = app.emit(
            "pty-output",
            PtyOutput {
                id: pty_id,
                data: text,
                surface_id: surface_id.clone(),
            },
        );
    };
    if final_flush {
        emit(String::from_utf8_lossy(acc).into_owned());
        acc.clear();
        return;
    }
    let valid = match std::str::from_utf8(acc) {
        Ok(_) => acc.len(),
        Err(e) => {
            if e.error_len().is_some() {
                // Genuinely invalid bytes mid-stream: flush lossily so we never
                // get stuck holding un-decodable input.
                emit(String::from_utf8_lossy(acc).into_owned());
                acc.clear();
                return;
            }
            e.valid_up_to()
        }
    };
    if valid == 0 {
        return; // only an incomplete multi-byte char buffered so far
    }
    emit(std::str::from_utf8(&acc[..valid]).unwrap().to_owned());
    acc.drain(..valid);
}

fn handle_tmux_event(
    event: TmuxEvent,
    pty_id: u32,
    surface_id: Option<&str>,
    state: &Arc<Mutex<TmuxCcState>>,
    app: &AppHandle,
) {
    let surface_id = surface_id.map(str::to_string);
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
                    surface_id: surface_id.clone(),
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
                    surface_id,
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

fn valid_spawn_cwd(cwd: Option<String>) -> Option<PathBuf> {
    let raw = cwd?;
    if raw.trim().is_empty() {
        return None;
    }
    let path = PathBuf::from(raw);
    path.is_dir().then_some(path)
}

/// Simple shell-like word splitting that respects quotes
fn shell_words_parse(s: &str) -> Vec<String> {
    split_command_line(s)
}

fn command_builder_from_argv(argv: &[String]) -> Result<CommandBuilder, String> {
    let Some(program) = argv.first().filter(|program| !program.is_empty()) else {
        return Err("Empty command".to_string());
    };
    let mut cb = CommandBuilder::new(program);
    for arg in &argv[1..] {
        cb.arg(arg);
    }
    Ok(cb)
}

fn generate_agent_session_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("Random token error: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_cwd_uses_existing_directories_only() {
        let current = std::env::current_dir().unwrap();
        assert_eq!(
            valid_spawn_cwd(Some(current.to_string_lossy().into_owned())),
            Some(current)
        );
        assert!(valid_spawn_cwd(Some(String::new())).is_none());
        assert!(valid_spawn_cwd(Some("__wmux_missing_directory__".to_string())).is_none());
        assert!(valid_spawn_cwd(None).is_none());
    }

    #[test]
    fn pending_agent_session_token_authorizes_before_instance_registration() {
        let manager = PtyManager::new();
        let context = WmuxPtyContext {
            workspace_id: Some("ws".to_string()),
            surface_id: Some("leaf".to_string()),
            enable_agent_session_reporting: true,
        };

        {
            let _pending = manager.register_pending_agent_session_token(&context, Some("token"));
            assert!(manager.agent_session_token_matches("ws", "leaf", "token"));
            assert!(!manager.agent_session_token_matches("ws", "leaf", "wrong"));
        }

        assert!(!manager.agent_session_token_matches("ws", "leaf", "token"));
    }
}
