//! Side-channel tmux RPCs over `ssh ... tmux <cmd>`.
//!
//! The attached PTY in `pty.rs` runs plain `tmux attach`, not control mode, so
//! session-list/switch must come through a separate SSH exec each time. We parse
//! the user-supplied `ssh ...` command, append connect-hardening options, and
//! invoke a one-shot remote command.

use serde::Serialize;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    pub id: String, // "$0"
    pub name: String,
    pub attached: bool,
    pub windows: u32,
    pub activity: u64, // unix epoch from tmux
}

/// Parse `ssh [opts] [-p PORT] [-i KEY] user@host` → (program, options, target).
/// Mirrors the parsing in `check_remote_tmux_sync` so callers can share it.
pub fn parse_ssh_args(ssh_command: &str) -> Option<(String, Vec<String>, String)> {
    let parts: Vec<&str> = ssh_command.split_whitespace().collect();
    if parts.is_empty() {
        return None;
    }
    let program = parts[0].to_string();
    let mut options: Vec<String> = Vec::new();
    let mut target: Option<String> = None;
    let mut i = 1;
    while i < parts.len() {
        match parts[i] {
            "-p" | "-i" => {
                options.push(parts[i].to_string());
                if i + 1 < parts.len() {
                    options.push(parts[i + 1].to_string());
                    i += 2;
                    continue;
                }
            }
            s if s.contains('@') => {
                target = Some(s.to_string());
            }
            _ => {
                options.push(parts[i].to_string());
            }
        }
        i += 1;
    }
    target.map(|t| (program, options, t))
}

/// Build an SSH `Command` with hardening options and target appended.
/// Caller adds the remote command as the next arg.
fn build_ssh(ssh_command: &str) -> Option<Command> {
    let (program, options, target) = parse_ssh_args(ssh_command)?;
    let mut cmd = Command::new(program);
    for o in &options {
        cmd.arg(o);
    }
    cmd.args([
        "-o",
        "ConnectTimeout=5",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
    ]);
    cmd.arg(target);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    // Silence SSH-side stderr (banner, ssh warnings) to keep wmux logs clean.
    // Remote tmux failures still surface via exit code.
    cmd.stderr(Stdio::null());
    Some(cmd)
}

/// Whitelist for tokens we splice unquoted into `tmux -t <token>`.
/// Allows session_id (`$N`), names from our sanitiser, and `@` / `_` / `-`.
/// Rejects `.`, `:`, whitespace, shell metacharacters.
fn safe_session_token(s: &str) -> Option<String> {
    if s.is_empty() {
        return None;
    }
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '$' | '@'))
    {
        Some(s.to_string())
    } else {
        None
    }
}

/// `tmux list-sessions` on the remote. Returns `Ok(vec![])` when no server is
/// running or tmux is missing — both are normal states, not errors.
pub fn list_sessions(ssh_command: &str) -> Result<Vec<TmuxSession>, String> {
    let mut cmd = build_ssh(ssh_command).ok_or_else(|| "invalid ssh command".to_string())?;
    cmd.arg(
        "tmux list-sessions -F '#{session_id}|#{session_name}|#{session_attached}|#{session_windows}|#{session_activity}' 2>/dev/null",
    );
    let out = cmd.output().map_err(|e| format!("ssh exec: {e}"))?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut sessions = Vec::new();
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 5 {
            continue;
        }
        sessions.push(TmuxSession {
            id: parts[0].to_string(),
            name: parts[1].to_string(),
            attached: parts[2].parse::<u32>().unwrap_or(0) > 0,
            windows: parts[3].parse().unwrap_or(0),
            activity: parts[4].parse().unwrap_or(0),
        });
    }
    Ok(sessions)
}

/// Switch the wmux-attached client(s) to `target_session`.
///
/// `wrapper_session` is the `wmux-<host>` session this wmux instance attached
/// to; we use it to discover our `client_tty` via `list-clients -t`. If no
/// matching client is found (e.g. user already detached), fall back to a plain
/// `switch-client -t` which acts on whichever client tmux picks.
pub fn switch_client(
    ssh_command: &str,
    wrapper_session: &str,
    target_session: &str,
) -> Result<(), String> {
    let wrapper =
        safe_session_token(wrapper_session).ok_or_else(|| "invalid wrapper".to_string())?;
    let target = safe_session_token(target_session).ok_or_else(|| "invalid target".to_string())?;
    // ssh runs the remote command via the login shell, so no extra `sh -c`
    // wrapper is needed (and adding one collides with the `'#{client_tty}'`
    // quotes inside, prematurely closing the outer wrap and turning `#...`
    // into a comment). Wrap the target in single quotes so the remote shell
    // does not expand `$N`-style session ids as positional parameters.
    let remote = format!(
        "ttys=$(tmux list-clients -t {wrapper} -F '#{{client_tty}}' 2>/dev/null); \
         if [ -z \"$ttys\" ]; then tmux switch-client -t '{target}'; \
         else for t in $ttys; do tmux switch-client -c \"$t\" -t '{target}'; done; fi"
    );
    let mut cmd = build_ssh(ssh_command).ok_or_else(|| "invalid ssh command".to_string())?;
    cmd.arg(remote);
    let out = cmd.output().map_err(|e| format!("ssh exec: {e}"))?;
    if !out.status.success() {
        return Err(format!("switch-client exited with {}", out.status));
    }
    Ok(())
}

/// Create a detached session and return its `session_id` (`$N`).
/// `name` is sanitised to `[A-Za-z0-9_-]`; rejected if it contains other chars.
pub fn new_session(ssh_command: &str, name: Option<&str>) -> Result<String, String> {
    let mut cmd = build_ssh(ssh_command).ok_or_else(|| "invalid ssh command".to_string())?;
    let remote = match name {
        Some(n) => {
            let safe = safe_session_token(n).ok_or_else(|| "invalid name".to_string())?;
            format!("tmux new-session -d -P -F '#{{session_id}}' -s {safe}")
        }
        None => "tmux new-session -d -P -F '#{session_id}'".to_string(),
    };
    cmd.arg(remote);
    let out = cmd.output().map_err(|e| format!("ssh exec: {e}"))?;
    if !out.status.success() {
        return Err(format!("new-session exited with {}", out.status));
    }
    let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if id.is_empty() {
        return Err("tmux returned empty session id".into());
    }
    Ok(id)
}

pub fn kill_session(ssh_command: &str, session: &str) -> Result<(), String> {
    let s = safe_session_token(session).ok_or_else(|| "invalid session".to_string())?;
    let mut cmd = build_ssh(ssh_command).ok_or_else(|| "invalid ssh command".to_string())?;
    // tmux defaults to `detach-on-destroy on`, so killing the session our
    // wmux client is attached to would close the SSH connection and tear
    // down the wmux pane (taking the AI split with it). Pre-migrate any
    // client attached to this session to another live session, then kill.
    let remote = format!(
        "alt=$(tmux list-sessions -F '#{{session_id}}' 2>/dev/null \
                | grep -F -v -x '{s}' | head -n1); \
         ttys=$(tmux list-clients -t '{s}' -F '#{{client_tty}}' 2>/dev/null); \
         if [ -n \"$ttys\" ] && [ -n \"$alt\" ]; then \
           for t in $ttys; do tmux switch-client -c \"$t\" -t \"$alt\"; done; \
         fi; \
         tmux kill-session -t '{s}'"
    );
    cmd.arg(remote);
    let out = cmd.output().map_err(|e| format!("ssh exec: {e}"))?;
    if !out.status.success() {
        return Err(format!("kill-session exited with {}", out.status));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_basic() {
        let (p, o, t) = parse_ssh_args("ssh -p 2222 -i /k user@host").unwrap();
        assert_eq!(p, "ssh");
        assert_eq!(o, vec!["-p", "2222", "-i", "/k"]);
        assert_eq!(t, "user@host");
    }

    #[test]
    fn parse_passthrough_options() {
        let (_, o, t) = parse_ssh_args("ssh -o StrictHostKeyChecking=no me@x").unwrap();
        assert!(o.contains(&"-o".to_string()));
        assert_eq!(t, "me@x");
    }

    #[test]
    fn parse_no_target() {
        assert!(parse_ssh_args("ssh -p 22").is_none());
    }

    #[test]
    fn safe_token_accepts() {
        assert!(safe_session_token("$3").is_some());
        assert!(safe_session_token("wmux-host").is_some());
        assert!(safe_session_token("foo_bar").is_some());
    }

    #[test]
    fn safe_token_rejects() {
        assert!(safe_session_token("foo bar").is_none());
        assert!(safe_session_token("foo;rm").is_none());
        assert!(safe_session_token("foo.bar").is_none());
        assert!(safe_session_token("").is_none());
    }
}
